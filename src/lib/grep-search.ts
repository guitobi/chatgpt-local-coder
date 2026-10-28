import fs from "fs/promises";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.[^\\/]+|node_modules|dist|build|coverage|vendor|credentials?[^\\/]*|secrets?[^\\/]*)($|[\\/])|\.(?:pem|key|p12|pfx)$/i;
const SENSITIVE_LINE = /(?:api[_-]?key|private[_-]?key|password|passwd|secret|bearer|auth[_-]?token|access[_-]?token)["']?\s*[:=]|sk-proj-|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/i;

export type GrepOutputMode = "content" | "files_with_matches" | "count";

interface GrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  outputMode?: GrepOutputMode;
  caseInsensitive?: boolean;
  multiline?: boolean;
  headLimit?: number;
  contextBefore?: number;
  contextAfter?: number;
  contextAround?: number;
  respectIgnore?: boolean;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git";
}

function buildRegex(pattern: string, caseInsensitive: boolean, multiline: boolean): RegExp {
  const flags = `${caseInsensitive ? "i" : ""}${multiline ? "m" : ""}`;
  return new RegExp(pattern, flags || undefined);
}

/** Use ripgrep only when its line-oriented behavior matches our public format. */
async function tryRipgrepSearch(options: {
  pattern: string;
  root: string;
  glob: string;
  outputMode: GrepOutputMode;
  caseInsensitive: boolean;
  headLimit: number;
  respectIgnore: boolean;
}): Promise<string | undefined> {
  const { pattern, root, glob, outputMode, caseInsensitive, headLimit, respectIgnore } = options;
  // More complex JS filename patterns retain the original scanner's semantics.
  if (glob !== "*" && !/^\*\.[a-zA-Z0-9_-]+$/.test(glob)) return undefined;
  if (headLimit <= 0) return "No matches found";

  const args = [
    "--no-heading", "--with-filename", "--no-messages",
    ...(!respectIgnore ? ["--no-ignore"] : ["--no-require-git"]),
    "--color", "never",
    // A positive --glob overrides .gitignore rules. In ignore-aware mode,
    // apply the caller's simple filename filter after ripgrep has enforced ignores.
    ...(respectIgnore ? [] : ["--glob-case-insensitive", "--glob", glob]),
    "--glob", "!**/node_modules/**", "--glob", "!**/.git/**",
    ...(respectIgnore ? [
      "--glob", "!**/.*", "--glob", "!**/credentials*", "--glob", "!**/secret*",
      "--glob", "!**/*.pem", "--glob", "!**/*.key", "--glob", "!**/*.p12", "--glob", "!**/*.pfx",
    ] : []),
    ...(caseInsensitive ? ["--ignore-case"] : []),
    ...(outputMode === "content" ? ["--line-number", "--max-count", String(headLimit)] : []),
    ...(outputMode === "count" ? ["--count"] : []),
    ...(outputMode === "files_with_matches" ? ["--files-with-matches"] : []),
    "--regexp", pattern, "--", root,
  ];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.env.LOCAL_CODER_RG_BIN || "rg", args, {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    }));
  } catch (error) {
    // Exit 1 means no matches. Missing binary, unsupported regex, timeouts,
    // and other errors must fall back rather than silently lose results.
    const code = (error as { code?: number | string }).code;
    if (code === 1 || code === "1") return "No matches found";
    return undefined;
  }

  const lines = stdout.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    if (!respectIgnore || glob === "*") return true;
    const parsed = outputMode === "content"
      ? /^(.+?):\d+:/.exec(line)
      : outputMode === "count" ? /^(.+?):\d+$/.exec(line) : null;
    return globToRegExp(glob).test(path.basename(parsed ? parsed[1] : line));
  });
  if (outputMode !== "content") return lines.slice(0, headLimit).join("\n") || "No matches found";

  const formatted = lines.slice(0, headLimit).map((line) => {
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    return match ? `${match[1]}:${match[2]}: ${match[3].trim()}` : line;
  });
  return formatted.join("\n") || "No matches found";
}

/**
 * Ignore-aware candidate selection is delegated to ripgrep. A glob is never
 * passed as a positive --glob, since that would override .gitignore rules.
 * When Rust regex syntax cannot parse a JS regex, enumerate safe files and
 * let the existing JS matcher decide. Missing/timed-out ripgrep fails closed.
 */
async function safeCandidateFiles(searchRoot: string, pattern: string, caseInsensitive: boolean, multiline: boolean, singleFile: boolean): Promise<string[]> {
  const base = singleFile ? path.dirname(searchRoot) : searchRoot;
  const common = [
    "--no-require-git", "--no-messages", "--null",
    "--glob", "!**/.*", "--glob", "!**/node_modules/**",
    "--glob", "!**/dist/**", "--glob", "!**/build/**",
    "--glob", "!**/coverage/**", "--glob", "!**/vendor/**",
    "--glob", "!**/credentials*", "--glob", "!**/secret*",
    "--glob", "!**/*.pem", "--glob", "!**/*.key",
    "--glob", "!**/*.p12", "--glob", "!**/*.pfx",
  ];
  const executable = process.env.LOCAL_CODER_RG_BIN || "rg";
  const options = { cwd: base, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const };
  let stdout = "";
  try {
    const args = [
      "--files-with-matches", ...common,
      ...(caseInsensitive ? ["--ignore-case"] : []),
      ...(multiline ? ["--multiline"] : []),
      "--regexp", pattern, "--", base,
    ];
    ({ stdout } = await execFileAsync(executable, args, options));
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1 || code === "1") return [];
    if (code !== 2 && code !== "2") {
      throw new Error("Ignore-aware grep requires ripgrep; refusing unsafe fallback");
    }
    try {
      ({ stdout } = await execFileAsync(executable, ["--files", ...common, "--", base], options));
    } catch (fallbackError) {
      const fallbackCode = (fallbackError as { code?: number | string }).code;
      if (fallbackCode === 1 || fallbackCode === "1") return [];
      throw new Error("Ignore-aware grep file enumeration failed; refusing unsafe fallback");
    }
  }
  return stdout.split("\0").filter(Boolean).map((name) => path.resolve(base, name)).filter((file) => {
    const relative = path.relative(base, file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) &&
      !SENSITIVE_PATH.test(relative) && (!singleFile || file === searchRoot);
  });
}

export async function grepSearch(options: GrepOptions): Promise<string> {
  const {
    pattern,
    path: searchRoot,
    glob = "*",
    outputMode = "content",
    caseInsensitive = false,
    multiline = false,
    headLimit = 200,
    contextBefore = 0,
    contextAfter = 0,
    contextAround = 0,
    respectIgnore = true,
  } = options;

  const before = contextAround || contextBefore;
  const after = contextAround || contextAfter;
  const regex = buildRegex(pattern, caseInsensitive, multiline);
  const globMatcher = globToRegExp(glob);

  let rootStat;
  try {
    rootStat = await fs.stat(searchRoot);
  } catch {
    return "No matches found";
  }
  if (rootStat.isFile() && !globMatcher.test(path.basename(searchRoot))) return "No matches found";

  if (!respectIgnore && !multiline && before === 0 && after === 0) {
    const fastResult = await tryRipgrepSearch({
      pattern, root: searchRoot, glob, outputMode, caseInsensitive, headLimit,
      respectIgnore,
    });
    if (fastResult !== undefined) return fastResult;
  }
  const candidates = respectIgnore
    ? await safeCandidateFiles(searchRoot, pattern, caseInsensitive, multiline, rootStat.isFile())
    : [];

  const fileMatches = new Map<string, number>();
  const contentLines: string[] = [];

  async function scanFile(fullPath: string): Promise<void> {
    if (!globMatcher.test(path.basename(fullPath))) return;
    if (respectIgnore) {
      const metadata = await fs.lstat(fullPath).catch(() => null);
      if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) return;
    }
    let text: string;
    try {
      text = await fs.readFile(fullPath, "utf-8");
    } catch {
      return;
    }

    const lines = text.split("\n");
    const hidden = new Set<number>();
    if (respectIgnore) {
      let inPrivateKey = false;
      for (let i = 0; i < lines.length; i++) {
        if (PRIVATE_KEY_BEGIN.test(lines[i])) inPrivateKey = true;
        if (inPrivateKey || SENSITIVE_LINE.test(lines[i])) hidden.add(i);
        if (PRIVATE_KEY_END.test(lines[i])) inPrivateKey = false;
      }
    }
    if (multiline) {
      const searchable = respectIgnore ? lines.map((line, i) => hidden.has(i) ? "" : line).join("\n") : text;
      const matches = searchable.match(regex);
      const count = matches?.length || 0;
      if (count > 0) {
        fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + count);
        if (outputMode === "content") {
          contentLines.push(`${fullPath}: [multiline match x${count}]`);
        }
      }
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      if (hidden.has(i)) continue;
      if (!regex.test(lines[i])) continue;

      fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + 1);

      if (outputMode === "content") {
        if (contentLines.length >= headLimit) break;
        if (before > 0 || after > 0) {
          const start = Math.max(0, i - before);
          const end = Math.min(lines.length - 1, i + after);
          for (let j = start; j <= end; j++) {
            if (hidden.has(j)) continue;
            const prefix = j === i ? ":" : "-";
            contentLines.push(`${fullPath}${prefix}${j + 1}: ${lines[j]}`);
            if (contentLines.length >= headLimit) break;
          }
        } else {
          contentLines.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  async function walk(dir: string): Promise<void> {
    if (outputMode === "content" && contentLines.length >= headLimit) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (outputMode === "content" && contentLines.length >= headLimit) break;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      await scanFile(fullPath);
    }
  }

  if (respectIgnore) {
    for (const file of candidates) {
      if (outputMode === "content" && contentLines.length >= headLimit) break;
      await scanFile(file);
    }
  } else if (rootStat.isFile()) await scanFile(searchRoot);
  else if (rootStat.isDirectory()) await walk(searchRoot);

  if (outputMode === "files_with_matches") {
    const files = [...fileMatches.keys()].slice(0, headLimit);
    return files.length ? files.join("\n") : "No matches found";
  }

  if (outputMode === "count") {
    const rows = [...fileMatches.entries()]
      .slice(0, headLimit)
      .map(([file, count]) => `${file}:${count}`);
    return rows.length ? rows.join("\n") : "No matches found";
  }

  return contentLines.length ? contentLines.join("\n") : "No matches found";
}