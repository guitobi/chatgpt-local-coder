import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { grepSearch } from "./grep-search.js";
import { validatePath } from "./path-security.js";
import { requireCommandAllowed } from "./permissions.js";
import { execArgvInDirectory, execInShellSession } from "./persistent-shell.js";
import { applySingleFilePatch, type SingleFilePatchResult } from "./single-file-patch.js";

const execFileAsync = promisify(execFile);
const MAX_MATCHES = 50;
const MAX_FILES = 5;
const MAX_SNIPPETS_PER_FILE = 3;
const MAX_CONTEXT_LINES = 5;
const MAX_LINE_CHARS = 240;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_GIT_ROWS = 30;
const SENSITIVE_INSPECT_PATH = /(?:^|[\\/])(?:\.[^\\/]*|credentials?[^\\/]*|secrets?[^\\/]*|id_rsa|[^\\/]*\.(?:pem|key|p12|pfx))(?:$|[\\/])/i;
const SENSITIVE_INSPECT_LINE = /(?:api[_-]?key|private[_-]?key|password|passwd|secret|auth[_-]?token|access[_-]?token)["']?\s*[:=]|authorization\s*:|sk-proj-|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i;

export interface InspectCodeOptions {
  root: string;
  query: string;
  glob?: string;
  maxMatches?: number;
  contextLines?: number;
}

interface SourceLine {
  line: number;
  text: string;
  truncated: boolean;
}

interface SourceSnippet {
  startLine: number;
  endLine: number;
  lines: SourceLine[];
}

interface FileExcerpt {
  path: string;
  snippets: SourceSnippet[];
  skipped?: string;
  truncated: boolean;
}

interface InspectionMatch {
  path: string;
  line: number;
  text: string;
  truncated: boolean;
}

interface GitState {
  available: boolean;
  status: string[];
  truncated: boolean;
  reason?: string;
}

export interface InspectionResult {
  root: string;
  query: string;
  glob: string;
  matches: InspectionMatch[];
  excerpts: FileExcerpt[];
  git: GitState;
  truncated: { matches: boolean; files: boolean; excerpts: boolean };
}

export interface DiagnosisOptions {
  root: string;
  command: string;
  commandMode?: "shell" | "argv";
  maxOutputChars?: number;
  timeoutMs?: number;
}

interface LogTail {
  text: string;
  truncated: boolean;
}

interface FailureLocation {
  path: string;
  line: number;
  column?: number;
  source: "stdout" | "stderr";
}

export interface DiagnosisResult {
  command: string;
  cwd: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout: LogTail;
  stderr: LogTail;
  locations: FailureLocation[];
  git: GitState;
}

export interface EditAndVerifyOptions {
  path: string;
  patch: string;
  command: string;
  commandMode?: "shell" | "argv";
  workingDirectory?: string;
  dryRun?: boolean;
  maxOutputChars?: number;
  timeoutMs?: number;
}

export interface EditAndVerifyResult {
  ok: boolean;
  patch_applied: boolean;
  verification_ran: boolean;
  patch: SingleFilePatchResult & {
    diff_truncated: boolean;
    hooks: {
      executed: number;
      failed: number;
      truncated: boolean;
      results: Array<{ file: string; glob: string; exit_code: number | null; stdout: string; stderr: string }>;
    };
  };
  verification: DiagnosisResult | null;
  verification_error?: string;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function parseExplicitArgv(command: string, mode: "shell" | "argv" = "shell"): string[] | null {
  if (mode === "shell") return null;
  if (mode !== "argv") throw new Error("Unknown verification command mode");
  let value: unknown;
  try {
    value = JSON.parse(command);
  } catch {
    throw new Error("argv verification command must be a JSON argument vector");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 ||
      value.some((part) => typeof part !== "string" || part.length === 0 ||
        part.length > 4096 || part.includes("\0"))) {
    throw new Error("argv verification command must be a nonempty JSON array of 1-32 bounded strings");
  }
  return value as string[];
}

function clip(text: string, limit = MAX_LINE_CHARS, focus?: string): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // Center around a plain-text query without evaluating arbitrary patterns
  // against a potentially huge minified line.
  const needle = focus && /^[a-zA-Z0-9_$-]+$/.test(focus) ? text.indexOf(focus) : -1;
  if (needle >= 0) {
    const start = Math.min(Math.max(0, needle - Math.floor(limit / 3)), text.length - limit + 2);
    const prefix = start > 0 ? "…" : "";
    const suffix = start + limit - prefix.length < text.length ? "…" : "";
    const content = text.slice(start, start + limit - prefix.length - suffix.length);
    return { text: `${prefix}${content}${suffix}`, truncated: true };
  }
  return { text: `${text.slice(0, limit - 1)}…`, truncated: true };
}

function parseMatches(output: string, query: string): InspectionMatch[] {
  if (output === "No matches found") return [];
  const matches: InspectionMatch[] = [];
  for (const row of output.split(/\r?\n/)) {
    // A drive-letter colon is not the file:line separator.
    const parsed = /^(.+?):([0-9]+): ?(.*)$/.exec(row);
    if (!parsed) continue;
    const line = Number(parsed[2]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    const safeText = SENSITIVE_INSPECT_LINE.test(parsed[3])
      ? "[potentially sensitive line omitted]"
      : parsed[3];
    matches.push({ path: parsed[1], line, ...clip(safeText, MAX_LINE_CHARS, query) });
  }
  return matches;
}

async function readGitState(root: string): Promise<GitState> {
  let cwd = root;
  try {
    if ((await fs.stat(root)).isFile()) cwd = path.dirname(root);
  } catch {
    return { available: false, status: [], truncated: false, reason: "Path does not exist" };
  }
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--untracked-files=normal"], {
      cwd, windowsHide: true, timeout: 4000, maxBuffer: 128 * 1024, encoding: "utf8",
    });
    const rows = stdout.split(/\r?\n/).filter(Boolean);
    return {
      available: true,
      status: rows.slice(0, MAX_GIT_ROWS).map((row) => clip(row, 200).text),
      truncated: rows.length > MAX_GIT_ROWS || rows.some((row) => row.length > 200),
    };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr || "";
    return {
      available: false,
      status: [],
      truncated: false,
      reason: /not a git repository/i.test(stderr) ? "Not a Git repository" : "Git status unavailable",
    };
  }
}

function isInsideRoot(file: string, root: string, rootIsFile: boolean): boolean {
  if (!path.isAbsolute(file)) return false;
  const relative = path.relative(rootIsFile ? path.dirname(root) : root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return !rootIsFile || path.resolve(file) === root;
}

async function rejectSymlinkComponents(file: string): Promise<void> {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink inspection path: ${current}`);
    if (current === path.dirname(current)) break;
  }
}

async function readExcerpt(root: string, file: string, hitLines: number[], context: number, query: string): Promise<FileExcerpt> {
  const result: FileExcerpt = { path: file, snippets: [], truncated: hitLines.length > MAX_SNIPPETS_PER_FILE };
  try {
    const rootIsFile = root === file;
    if (!isInsideRoot(file, root, rootIsFile) || SENSITIVE_INSPECT_PATH.test(path.relative(rootIsFile ? path.dirname(root) : root, file))) {
      result.skipped = "File is outside inspected scope or sensitive";
      return result;
    }
    await rejectSymlinkComponents(file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      result.skipped = "Not a regular file";
      return result;
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      result.skipped = "File exceeds excerpt size limit";
      return result;
    }
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    if (!isInsideRoot(realFile, realRoot, rootIsFile)) {
      result.skipped = "Resolved file escapes inspected scope";
      return result;
    }
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
        opened.dev !== stat.dev || opened.ino !== stat.ino ||
        named.dev !== stat.dev || named.ino !== stat.ino || opened.size > MAX_SOURCE_BYTES) {
        result.skipped = "Source changed during inspection";
        return result;
      }
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    if (text.includes("\0")) {
      result.skipped = "Binary file";
      return result;
    }
    let inPrivateKey = false;
    const lines = text.split(/\r?\n/).map((line) => {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(line)) inPrivateKey = true;
      if (inPrivateKey) {
        if (/-----END [A-Z ]*PRIVATE KEY-----/i.test(line)) inPrivateKey = false;
        return "[private key material omitted]";
      }
      return SENSITIVE_INSPECT_LINE.test(line) ? "[potentially sensitive line omitted]" : line;
    });
    const windows: Array<{ start: number; end: number }> = [];
    for (const line of hitLines.slice(0, MAX_SNIPPETS_PER_FILE)) {
      const start = Math.max(1, line - context);
      const end = Math.min(lines.length, line + context);
      const previous = windows[windows.length - 1];
      if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
      else windows.push({ start, end });
    }
    result.snippets = windows.map(({ start, end }) => ({
      startLine: start,
      endLine: end,
      lines: Array.from({ length: end - start + 1 }, (_, index) => ({
        line: start + index,
        ...clip(lines[start + index - 1], MAX_LINE_CHARS, query),
      })),
    }));
    result.truncated ||= result.snippets.some((snippet) => snippet.lines.some((line) => line.truncated));
  } catch {
    result.skipped = "File unreadable";
  }
  return result;
}

/** Collect bounded search evidence and read-only Git state in one operation. */
export async function inspectCode(options: InspectCodeOptions): Promise<InspectionResult> {
  const root = path.resolve(options.root);
  const query = options.query;
  const glob = options.glob || "*";
  const maxMatches = boundedInteger(options.maxMatches, 20, 1, MAX_MATCHES);
  const context = boundedInteger(options.contextLines, 2, 0, MAX_CONTEXT_LINES);
  await rejectSymlinkComponents(root);
  const rootIsFile = await fs.lstat(root).then((stat) => stat.isFile()).catch(() => false);

  const [searchOutput, git] = await Promise.all([
    grepSearch({ path: root, pattern: query, glob, headLimit: maxMatches + 1, respectIgnore: true }),
    readGitState(root),
  ]);
  const parsedMatches = parseMatches(searchOutput, query).filter((match) =>
    isInsideRoot(match.path, root, rootIsFile) &&
    !SENSITIVE_INSPECT_PATH.test(path.relative(rootIsFile ? path.dirname(root) : root, match.path)));
  const matches = parsedMatches.slice(0, maxMatches);
  const files = new Map<string, number[]>();
  let filesTruncated = false;
  for (const match of matches) {
    if (!files.has(match.path)) {
      if (files.size === MAX_FILES) {
        filesTruncated = true;
        continue;
      }
      files.set(match.path, []);
    }
    const lines = files.get(match.path)!;
    if (!lines.includes(match.line)) lines.push(match.line);
  }
  const excerpts = await Promise.all(
    [...files.entries()].map(([file, lines]) => readExcerpt(root, file, lines, context, query)),
  );
  // Only release source text read through the scope, symlink, and secret checks.
  // Matches beyond the excerpt budget retain locations but not raw rg output.
  const safeLines = new Map<string, Map<number, SourceLine>>();
  for (const excerpt of excerpts) {
    if (excerpt.skipped) continue;
    const byLine = new Map<number, SourceLine>();
    for (const snippet of excerpt.snippets) {
      for (const line of snippet.lines) byLine.set(line.line, line);
    }
    safeLines.set(excerpt.path, byLine);
  }
  const safeMatches = matches.map((match) => {
    const safe = safeLines.get(match.path)?.get(match.line);
    return { ...match, text: safe?.text ?? "[source line not excerpted]", truncated: safe?.truncated ?? false };
  });
  return {
    root, query, glob, matches: safeMatches, excerpts, git,
    truncated: {
      matches: parsedMatches.length > maxMatches,
      files: filesTruncated,
      excerpts: excerpts.some((excerpt) => excerpt.truncated || Boolean(excerpt.skipped)),
    },
  };
}

function logTail(raw: string, maxChars: number): LogTail {
  if (maxChars <= 0) return { text: "", truncated: raw.length > 0 };
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  return { text: raw.slice(-maxChars), truncated: true };
}

function errorLocations(stdout: string, stderr: string): FailureLocation[] {
  const locations: FailureLocation[] = [];
  const seen = new Set<string>();
  // Scan only a bounded tail. Output is untrusted text, never an instruction.
  for (const [source, stream] of [["stderr", stderr], ["stdout", stdout]] as const) {
    const tail = stream.slice(-100_000);
    // Drive-absolute paths can contain spaces and parentheses. Handle both
    // file:line:column and TypeScript's file(line,column) diagnostics.
    const pattern = /(?:^|[\s(])((?:(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])[^:\r\n]*?|[^:\s()]+)\.(?:[cm]?[jt]sx?|py|go|rs|java|json|vue|svelte))(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))/gm;
    for (const match of tail.matchAll(pattern)) {
      if (match[1].length > 512) continue;
      const line = Number(match[2] || match[4]);
      const column = match[3] || match[5] ? Number(match[3] || match[5]) : undefined;
      if (!Number.isSafeInteger(line) || line < 1 || (column !== undefined && !Number.isSafeInteger(column))) continue;
      const key = `${match[1]}:${line}:${column ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ path: match[1], line, ...(column === undefined ? {} : { column }), source });
      if (locations.length >= 12) return locations;
    }
  }
  return locations;
}

/** Run an explicitly supplied command using the same authorization and shell as run_command. */
export async function diagnoseFailure(options: DiagnosisOptions): Promise<DiagnosisResult> {
  requireCommandAllowed(options.command);
  const argv = parseExplicitArgv(options.command, options.commandMode);
  const cwd = await validatePath(options.root);
  const timeoutMs = boundedInteger(options.timeoutMs, 60_000, 100, 120_000);
  const maxOutputChars = boundedInteger(options.maxOutputChars, 6_000, 128, 20_000);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  try {
    const result = argv
      ? await execArgvInDirectory(argv, cwd, timeoutMs)
      : await execInShellSession(options.command, cwd, timeoutMs, cwd);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exit_code;
    timedOut = result.timed_out;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; timed_out?: boolean };
    if (!failure.timed_out && !/^Command timed out after /.test(failure.message)) throw error;
    timedOut = true;
    stdout = failure.stdout || "";
    stderr = [failure.stderr, failure.message].filter(Boolean).join("\n");
  }
  const locations = errorLocations(stdout, stderr);
  const stderrTail = logTail(stderr, maxOutputChars);
  const stdoutTail = logTail(stdout, maxOutputChars - stderrTail.text.length);
  // A passing command needs no extra Git subprocess; failures still include
  // repository state so the agent can diagnose and recover in one call.
  const git: GitState = !timedOut && exitCode === 0
    ? { available: false, status: [], truncated: false, reason: "Skipped after successful command" }
    : await readGitState(cwd);
  return {
    command: options.command, cwd, exit_code: exitCode, timed_out: timedOut,
    stdout: stdoutTail, stderr: stderrTail, locations, git,
  };
}

/** Apply one explicit file patch and run one explicit verification command; never auto-rollback. */
export async function editAndVerify(options: EditAndVerifyOptions): Promise<EditAndVerifyResult> {
  // Validate the command and test directory before modifying any file.
  requireCommandAllowed(options.command);
  parseExplicitArgv(options.command, options.commandMode);
  const filePath = await validatePath(options.path);
  const cwd = options.workingDirectory
    ? await validatePath(options.workingDirectory)
    : path.dirname(filePath);
  if (!(await fs.stat(cwd)).isDirectory()) {
    throw new Error("Verification working_directory must be an existing directory");
  }

  const updated = await applySingleFilePatch({
    path: filePath,
    patch: options.patch,
    dryRun: options.dryRun,
    checkpointTool: "edit_and_verify",
  });
  const maxDiffChars = 4_000;
  const rawHooks = (updated as SingleFilePatchResult & {
    post_edit_hooks?: Array<Record<string, unknown>>;
  }).post_edit_hooks ?? [];
  const hookFailures = rawHooks.filter((hook) => hook.exit_code !== 0).length;
  const patch = {
    path: updated.path,
    diff: updated.diff.slice(0, maxDiffChars),
    diff_truncated: updated.diff.length > maxDiffChars,
    dry_run: updated.dry_run,
    checkpoint_id: updated.checkpoint_id,
    hooks: {
      executed: rawHooks.length,
      failed: hookFailures,
      truncated: rawHooks.length > 5,
      results: rawHooks.slice(0, 5).map((hook) => ({
        file: String(hook.file ?? "").slice(0, 240),
        glob: String(hook.glob ?? "").slice(0, 100),
        exit_code: typeof hook.exit_code === "number" ? hook.exit_code : null,
        stdout: String(hook.stdout ?? "").slice(-300),
        stderr: String(hook.stderr ?? "").slice(-300),
      })),
    },
  };
  if (options.dryRun) {
    return { ok: true, patch_applied: false, verification_ran: false, patch, verification: null };
  }

  let verification: DiagnosisResult;
  try {
    verification = await diagnoseFailure({
      root: cwd,
      command: options.command,
      commandMode: options.commandMode,
      maxOutputChars: options.maxOutputChars,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    // Patching already happened: preserve its checkpoint in the structured result
    // even if the shell executable cannot start or the runner fails unexpectedly.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      patch_applied: true,
      verification_ran: false,
      patch,
      verification: null,
      verification_error: message.slice(0, 500),
    };
  }
  const ok = !verification.timed_out && verification.exit_code === 0 && hookFailures === 0;
  return { ok, patch_applied: true, verification_ran: true, patch, verification };
}