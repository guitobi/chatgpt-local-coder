import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants } from "node:fs";

const execFileAsync = promisify(execFile);
const MAX_CANDIDATES = 4000;
// Under this bound, safely reading the ignore-filtered candidates is cheaper
// than launching one ripgrep process per query term on Windows.
const MAX_LOCAL_SCAN_CANDIDATES = 96;
const MAX_GROUPED_CONTENT_FILES = 128;
const CONTENT_SAMPLE_FILES = 24;
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_LINE_CHARS = 200;
const CODE_TYPE = "taskcode:*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,vue,svelte,rb,php,sql,sh,ps1}";
const CODE_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|cs|vue|svelte|rb|php|sql|sh|ps1)$/i;
const IMPLEMENTATION_DIR = /(?:^|[\\/])(?:src|app|lib|pkg|internal|server|client)[\\/]/i;
const EXCLUDED_DIRS = /(^|[\\/])(?:node_modules|dist|build|coverage|vendor|target|__pycache__|\.git|\.next|\.venv)(?:[\\/]|$)/i;
const SENSITIVE_NAMES = /(?:^|[\\/])(?:credentials?[^\\/]*|secrets?[^\\/]*|id_rsa|.*\.(?:pem|key|p12|pfx)|\.env(?:\..*)?)(?:$|[\\/])/i;
const SENSITIVE_LINE = /(?:api[_-]?key|private[_-]?key|password|passwd|secret|bearer|auth[_-]?token|access[_-]?token)["']?\s*[:=]|sk-proj-|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/i;
const STOPWORDS = new Set([
  "fix", "change", "handle", "handling", "error", "errors", "bug", "bugs", "for", "the", "and", "with", "from", "this", "that", "please", "file", "files", "code", "test", "tests", "add", "update", "make", "issue", "problem",
  "помилка", "помилки", "виправ", "виправити", "зроби", "змінити", "додати", "треба", "будь", "ласка", "файл", "файли", "коду", "коді", "для", "при", "щоб", "який", "яка", "яке", "вже", "тести",
]);

export interface TaskContextOptions {
  root: string;
  task: string;
  maxFiles?: number;
  maxChars?: number;
}

export interface TaskContextResult {
  root: string;
  terms: string[];
  files: Array<{
    path: string;
    score: number;
    reasons: string[];
    lines: Array<{ number: number; text: string }>;
  }>;
  instructions: Array<{ path: string; content: string; truncated: boolean }>;
  searched_files: number;
  truncated: boolean;
  warnings: string[];
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function allowed(root: string, candidate: string): boolean {
  if (!withinRoot(root, candidate)) return false;
  const relative = path.relative(root, candidate);
  if (relative.split(path.sep).some((part) => part.startsWith("."))) return false;
  return CODE_EXTENSION.test(candidate) && !EXCLUDED_DIRS.test(relative) && !SENSITIVE_NAMES.test(relative);
}

function keywords(task: string): string[] {
  return [...new Set((task.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && term.length <= 80 && !STOPWORDS.has(term)))].slice(0, 8);
}

/** Conservative English inflections; never expand a term into broad synonyms. */
function searchVariants(term: string): string[] {
  const values = [term];
  if (term.length >= 6 && term.endsWith("ies")) values.push(`${term.slice(0, -3)}y`);
  else if (term.length >= 5 && term.endsWith("s") && !/(?:ss|us|is)$/.test(term)) {
    values.push(term.slice(0, -1));
  }
  if (term.length >= 7 && term.endsWith("ing")) {
    const base = term.slice(0, -3);
    values.push(base, `${base}e`);
    if (/(.)\1$/.test(base)) values.push(base.slice(0, -1));
  }
  if (term.length >= 6 && term.endsWith("ed")) values.push(term.slice(0, -2));
  return [...new Set(values)];
}

function includesTerm(haystack: string, term: string): boolean {
  return searchVariants(term).some((form) => haystack.includes(form));
}

async function ripgrep(args: string[], root: string, maxBuffer = 2 * 1024 * 1024): Promise<string[]> {
  const { stdout } = await execFileAsync(process.env.LOCAL_CODER_RG_BIN || "rg", args, {
    cwd: root, windowsHide: true, timeout: 7000, maxBuffer,
    encoding: "utf8",
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

function fileNameScore(relative: string, terms: string[]): number {
  const name = path.basename(relative).toLowerCase();
  const folder = path.dirname(relative).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (includesTerm(name, term)) score += 16;
    else if (includesTerm(folder, term)) score += 8;
  }
  return score;
}

function redactInstructionLines(content: string): string {
  let inPrivateKey = false;
  return content.split(/\r?\n/).map((line) => {
    if (PRIVATE_KEY_BEGIN.test(line)) inPrivateKey = true;
    const redact = inPrivateKey || SENSITIVE_LINE.test(line);
    if (PRIVATE_KEY_END.test(line)) inPrivateKey = false;
    return redact ? "[potentially sensitive line omitted]" : line;
  }).join("\n");
}

async function readBoundedFile(root: string, file: string): Promise<{ content: string; size: number; oversized: boolean } | null> {
  try {
    if (!withinRoot(root, file)) return null;
    for (let folder = path.dirname(file); withinRoot(root, folder); folder = path.dirname(folder)) {
      const parent = await fs.lstat(folder);
      if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
      if (folder === root) break;
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_SOURCE_BYTES) return { content: "", size: stat.size, oversized: true };
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    if (!withinRoot(realRoot, realFile)) return null;
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      const named = await fs.lstat(file);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
        opened.dev !== stat.dev || opened.ino !== stat.ino ||
        named.dev !== stat.dev || named.ino !== stat.ino) return null;
      if (opened.size > MAX_SOURCE_BYTES) return { content: "", size: opened.size, oversized: true };
      const bytes = Buffer.alloc(opened.size);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      return { content: bytes.subarray(0, used).toString("utf8"), size: opened.size, oversized: false };
    } finally { await handle.close(); }
  } catch { return null; }
}

async function safeLines(root: string, file: string, terms: string[]): Promise<Array<{ number: number; text: string }>> {
  try {
    const safe = await readBoundedFile(root, file);
    if (!safe || safe.oversized) return [];
    const content = safe.content;
    if (content.includes("\0")) return [];
    const lines = content.split(/\r?\n/);
    const matches: Array<{ number: number; text: string; score: number }> = [];
    const seen = new Set<string>();
    let inPrivateKey = false;
    for (let i = 0; i < lines.length; i++) {
      if (PRIVATE_KEY_BEGIN.test(lines[i])) inPrivateKey = true;
      const hidden = inPrivateKey;
      if (PRIVATE_KEY_END.test(lines[i])) inPrivateKey = false;
      if (hidden) continue;
      const lowered = lines[i].toLowerCase();
      const coverage = terms.filter((term) => includesTerm(lowered, term)).length;
      if (!coverage) continue;
      const text = SENSITIVE_LINE.test(lines[i])
        ? "[potentially sensitive line omitted]"
        : lines[i].slice(0, MAX_LINE_CHARS);
      const distinct = text.trim();
      if (seen.has(distinct)) continue;
      seen.add(distinct);
      const isComment = /^\s*(?:\/\/|\/\*|\*|#)/.test(lines[i]);
      matches.push({ number: i + 1, text, score: (isComment ? 0 : 100) + coverage });
    }
    matches.sort((a, b) => b.score - a.score || a.number - b.number);
    return matches.slice(0, 3).sort((a, b) => a.number - b.number)
      .map(({ number, text }) => ({ number, text }));
  } catch {
    return [];
  }
}

/** Resolve only explicit relative imports to paths already approved by ripgrep enumeration. */
function directLocalImports(sourceFile: string, sourceText: string): string[] {
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(sourceFile)) return [];
  const result: string[] = [];
  for (const line of sourceText.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    const match = /\b(?:import|export)\b[^\r\n]*?\bfrom\s*["'](\.[^"']+)["']|^\s*import\s*["'](\.[^"']+)["']/.exec(line);
    const commonjs = /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/.exec(line);
    const specifier = match?.[1] ?? match?.[2] ?? commonjs?.[1];
    if (!specifier || specifier.includes("\0")) continue;
    const target = path.resolve(path.dirname(sourceFile), specifier);
    const extension = path.extname(target).toLowerCase();
    const attempts = extension === ".js"
      ? [target, target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx"]
      : extension === "" ? [target + ".ts", target + ".tsx", target + ".js",
        path.join(target, "index.ts"), path.join(target, "index.js")] : [target];
    result.push(...attempts);
    if (result.length >= 48) break;
  }
  return result;
}

async function safeDependencyLines(root: string, file: string): Promise<Array<{ number: number; text: string }>> {
  const safe = await readBoundedFile(root, file);
  if (!safe || safe.oversized || safe.content.includes("\0")) return [];
  const evidence: Array<{ number: number; text: string }> = [];
  let inPrivateKey = false;
  for (const [index, line] of safe.content.split(/\r?\n/).entries()) {
    if (PRIVATE_KEY_BEGIN.test(line)) inPrivateKey = true;
    const hidden = inPrivateKey || SENSITIVE_LINE.test(line);
    if (PRIVATE_KEY_END.test(line)) inPrivateKey = false;
    // Unlike an explicitly searched source excerpt, this dependency was
    // discovered indirectly. Only expose declaration lines, not arbitrary
    // initializers such as `const TOKEN = '...'` from an unrelated helper.
    if (hidden) continue;
    const commonjsExport = /^\s*(?:module\.exports|exports)\.[A-Za-z_$][\w$]*\s*=/.exec(line);
    if (commonjsExport) {
      // Only reveal the export's name, never an initializer with possible secrets.
      evidence.push({ number: index + 1, text: commonjsExport[0].trimEnd() + " [value omitted]" });
      if (evidence.length === 2) break;
      continue;
    }
    if (!/^\s*(?:export\s+)?(?:(?:async\s+)?function|class|interface|type)\b/.test(line)) continue;
    // Even a function declaration can contain a hardcoded literal in its
    // inline body. Include its signature, never the unrelated body/value.
    const brace = line.indexOf("{");
    const typeValue = /^\s*(?:export\s+)?type\b/.test(line) ? line.indexOf("=") : -1;
    const declaration = line.slice(0, typeValue >= 0 ? typeValue : brace >= 0 ? brace + 1 : line.length);
    const quoted = [declaration.indexOf("'"), declaration.indexOf('"'), declaration.indexOf("`")]
      .filter((position) => position >= 0);
    const safeText = quoted.length ? `${declaration.slice(0, Math.min(...quoted)).trimEnd()} [literal omitted]`
      : declaration.trimEnd();
    evidence.push({ number: index + 1, text: safeText.slice(0, MAX_LINE_CHARS) });
    if (evidence.length === 2) break;
  }
  return evidence;
}

async function scopedInstructions(root: string, selected: string[]) {
  const folders = new Set([root]);
  for (const file of selected) {
    let folder = path.dirname(file);
    while (withinRoot(root, folder)) {
      folders.add(folder);
      if (folder === root) break;
      folder = path.dirname(folder);
    }
  }
  const results: TaskContextResult["instructions"] = [];
  for (const folder of [...folders].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = path.join(folder, name);
      try {
        const safe = await readBoundedFile(root, file);
        if (!safe) continue;
        if (safe.oversized) {
          results.push({ path: file, content: "[instruction file too large; read manually]", truncated: true });
          continue;
        }
        const content = redactInstructionLines(safe.content).slice(0, 800);
        results.push({ path: file, content, truncated: safe.size > Buffer.byteLength(content) });
      } catch {}
      if (results.length >= 6) return results;
    }
  }
  return results;
}

/** Ignore-aware, read-only lexical evidence for an unfamiliar coding task. */
export async function buildTaskContext(options: TaskContextOptions): Promise<TaskContextResult> {
  if (!options.task?.trim()) throw new Error("task must not be empty");
  const root = path.resolve(options.root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("task_context path must be a directory");
  const terms = keywords(options.task);
  const explicitSymbols = new Set((options.task.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((value) => /[_\d]|[a-z][A-Z]|[A-Z]{2}/.test(value))
    .map((value) => value.toLowerCase()));
  const maxFiles = Math.max(1, Math.min(8, Math.floor(options.maxFiles ?? 6)));
  const maxChars = Math.max(1024, Math.min(20_000, Math.floor(options.maxChars ?? 9000)));
  const result: TaskContextResult = {
    root, terms, files: [], instructions: [], searched_files: 0, truncated: false, warnings: [],
  };
  if (!terms.length) {
    result.warnings.push("No searchable task terms; provide a code symbol, feature name, or filename");
    return result;
  }

  const rootIgnore = path.join(root, ".gitignore");
  const ignoreArgs: string[] = [];
  try {
    if ((await fs.lstat(rootIgnore)).isFile()) ignoreArgs.push("--ignore-file", rootIgnore);
  } catch { /* No root ignore file; ripgrep still reads nested ignore files. */ }

  let rawFiles: string[];
  try {
    rawFiles = await ripgrep([
      "--files", "--no-require-git", "--no-messages", "--sort", "path",
      ...ignoreArgs, "--type-add", CODE_TYPE, "--type", "taskcode", "--", root,
    ], root);
  } catch {
    result.warnings.push("ripgrep unavailable or failed; refusing to scan potentially ignored private files");
    return result;
  }
  const allCandidates = rawFiles
    .map((file) => path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file))
    .filter((file) => allowed(root, file));
  if (allCandidates.length > MAX_CANDIDATES) result.truncated = true;
  let candidates = allCandidates.slice(0, MAX_CANDIDATES);
  result.searched_files = candidates.length;
  const matchCounts = new Map<string, number>();
  const termHits = new Map(terms.map((term) => [term, new Set<string>()]));
  let mostFrequentTermHits = 1;
  const registerTermHit = (file: string, term: string): void => {
    const hits = termHits.get(term)!;
    hits.add(file);
    mostFrequentTermHits = Math.max(mostFrequentTermHits, hits.size);
  };
  const rareTermBonus = (file: string): number => {
    if (terms.length <= 1 || mostFrequentTermHits <= 1) return 0;
    let bonus = 0;
    for (const term of terms) {
      // Generic prose can contain incidentally rare words. Promote only
      // explicitly named symbols (camelCase, snake_case, acronyms, digits).
      if (!explicitSymbols.has(term)) continue;
      const hits = termHits.get(term)!;
      if (hits.has(file)) bonus += Math.round(24 * (1 - hits.size / mostFrequentTermHits));
    }
    return Math.min(24, bonus);
  };
  const localContents = new Map<string, string>();
  if (candidates.length <= MAX_LOCAL_SCAN_CANDIDATES && terms.every((term) => /^[\x00-\x7f]+$/.test(term))) {
    // Enumeration already applied nested .gitignore rules. Keep the same
    // symlink/size/realpath/descriptor protections used for returned excerpts.
    await Promise.all(candidates.map(async (file) => {
      const safe = await readBoundedFile(root, file);
      if (!safe || safe.oversized || safe.content.includes("\0")) return;
      const content = safe.content.toLowerCase();
      localContents.set(file, content);
      const matched = terms.filter((term) => includesTerm(content, term));
      if (matched.length) matchCounts.set(file, matched.length);
      for (const term of matched) registerTermHit(file, term);
    }));
  } else {
    const enumeratedSet = new Set(allCandidates);
    let grouped = false;
    if (terms.length > 1) {
      // A bounded, spread-out sample avoids an extra full scan when common
      // words would produce thousands of matches. Every sample uses the same
      // descriptor and symlink validation as public source excerpts.
      const sampleCount = Math.min(CONTENT_SAMPLE_FILES, allCandidates.length);
      const sampleFiles = Array.from({ length: sampleCount }, (_, index) =>
        allCandidates[Math.floor(((index + 0.5) * allCandidates.length) / sampleCount)]);
      const sampled = await Promise.all(sampleFiles.map((file) => readBoundedFile(root, file)));
      const commonMatches = sampled.filter((source) => source && !source.oversized &&
        terms.some((term) => includesTerm(source.content.toLowerCase(), term))).length;
      if (commonMatches <= 1) {
        try {
          // Abort the combined scan as soon as its stdout cannot represent
          // 128 complete enumerated paths. A broader result would require
          // the exact per-term fallback anyway. Byte lengths cover Unicode.
          const longestPathBytes = allCandidates.reduce((max, file) =>
            Math.max(max, Buffer.byteLength(file, "utf8")), 0);
          const groupOutputLimit = Math.min(2 * 1024 * 1024,
            MAX_GROUPED_CONTENT_FILES * (longestPathBytes + 2));
          const matches = await ripgrep([
            "--files-with-matches", "--no-require-git", "--no-messages", "--fixed-strings", "--ignore-case", "--max-filesize", "128K",
            ...ignoreArgs, "--type-add", CODE_TYPE, "--type", "taskcode",
            ...terms.flatMap((term) => searchVariants(term)).flatMap((form) => ["--regexp", form]), "--", root,
          ], root, groupOutputLimit);
          const matchedFiles = [...new Set(matches.map((name) => path.isAbsolute(name)
            ? path.resolve(name) : path.resolve(root, name)))].filter((file) => enumeratedSet.has(file));
          if (matchedFiles.length <= MAX_GROUPED_CONTENT_FILES) {
            await Promise.all(matchedFiles.map(async (file) => {
              const safe = await readBoundedFile(root, file);
              if (!safe || safe.oversized || safe.content.includes("\0")) return;
              const code = safe.content.toLowerCase();
              localContents.set(file, code);
              const matched = terms.filter((term) => includesTerm(code, term));
              if (matched.length) matchCounts.set(file, matched.length);
              for (const term of matched) registerTermHit(file, term);
            }));
            grouped = true;
          }
        } catch (error) {
          // Exit 1 means no matches. A full stdout budget aborts the child;
          // then use exact ignore-aware per-term searches, not raw traversal.
          if ((error as { code?: number | string }).code === 1) grouped = true;
        }
      }
    }
    if (!grouped) {
      const matchesByTerm = await Promise.all(terms.map(async (term) => {
        try {
          return await ripgrep([
            "--files-with-matches", "--no-require-git", "--no-messages", "--fixed-strings", "--ignore-case", "--max-filesize", "128K",
            ...ignoreArgs, "--type-add", CODE_TYPE, "--type", "taskcode",
            ...searchVariants(term).flatMap((form) => ["--regexp", form]), "--", root,
          ], root);
        } catch (error) {
          if ((error as { code?: number | string }).code !== 1) {
            result.warnings.push("ripgrep content search failed for a task term");
          }
          return [];
        }
      }));
      for (const [index, matches] of matchesByTerm.entries()) {
        for (const name of new Set(matches)) {
          const file = path.isAbsolute(name) ? path.resolve(name) : path.resolve(root, name);
          if (enumeratedSet.has(file)) {
            matchCounts.set(file, (matchCounts.get(file) ?? 0) + 1);
            registerTermHit(file, terms[index]);
          }
        }
      }
    }
    if (allCandidates.length > MAX_CANDIDATES) {
      // Keep the 4k memory/evidence budget while allowing an exact match
      // near the end of a large alphabetically enumerated tree to be found.
      const relevant = allCandidates.filter((file) =>
        matchCounts.has(file) || fileNameScore(path.relative(root, file), terms) > 0);
      relevant.sort((a, b) => {
        const aScore = fileNameScore(path.relative(root, a), terms) + (matchCounts.get(a) ?? 0) * 10 + rareTermBonus(a);
        const bScore = fileNameScore(path.relative(root, b), terms) + (matchCounts.get(b) ?? 0) * 10 + rareTermBonus(b);
        return bScore - aScore || a.localeCompare(b);
      });
      const selected = new Set<string>();
      for (const file of [...relevant, ...allCandidates]) {
        if (selected.size >= MAX_CANDIDATES) break;
        selected.add(file);
      }
      candidates = [...selected];
    }
  }

  result.searched_files = candidates.length;
  // For requests about exposing/registering tools, a real registration is
  // stronger evidence of ownership than a catalog merely listing tool names.
  const registeredToolHits = new Map<string, number>();
  if (terms.some((term) => /^(?:expose|register|registering|registration|registered)$/.test(term))) {
    const registrarCandidates = candidates.filter((file) =>
      /(?:^|[\\/])tools[\\/]/i.test(path.relative(root, file))).slice(0, 96);
    await Promise.all(registrarCandidates.map(async (file) => {
      const cached = localContents.get(file);
      const source = cached === undefined ? await readBoundedFile(root, file) : null;
      const code = cached ?? (source && !source.oversized ? source.content.toLowerCase() : "");
      if (!code || code.includes("\0")) return;
      const names = [...code.matchAll(/\bregisterTool\s*\(\s*["'`]([^"'`]+)["'`]/gi)]
        .map((match) => match[1].toLowerCase());
      const matches = terms.filter((term) => names.some((name) => includesTerm(name, term))).length;
      if (matches >= 2) registeredToolHits.set(file, Math.min(60, matches * 30));
    }));
  }

  const ranked = candidates.map((file) => {
    const relative = path.relative(root, file);
    const fromName = fileNameScore(relative, terms);
    const contentTerms = matchCounts.get(file) ?? 0;
    const isTest = /(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/i.test(relative);
    // Source implementations generally give the agent a better starting point
    // than generated scripts or regression fixtures with the same keyword.
    const sourceBoost = !isTest && IMPLEMENTATION_DIR.test(relative) ? 24 : 0;
    const registrarScore = registeredToolHits.get(file) ?? 0;
    const rarityBoost = rareTermBonus(file);
    const score = fromName + contentTerms * 10 + ((fromName || contentTerms) ? sourceBoost : 0) + registrarScore + rarityBoost;
    const reasons = [
      ...(fromName ? ["matching path"] : []),
      ...(contentTerms ? [`matching ${contentTerms} task terms in content`] : []),
      ...(sourceBoost && (fromName || contentTerms) ? ["implementation source"] : []),
      ...(registrarScore ? ["matching registered tool names"] : []),
      ...(rarityBoost ? ["rare task term"] : []),
    ];
    return { path: file, score, reasons };
  }).filter((file) => file.score > 0);
  // A matching test related to a matching source file adds regression context.
  const sourceStems = new Set(ranked.filter((file) => !/(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/i.test(file.path))
    .map((file) => path.basename(file.path).replace(CODE_EXTENSION, "").toLowerCase()));
  for (const file of ranked) {
    if (/(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/i.test(file.path) &&
        [...sourceStems].some((stem) => stem.length > 2 && file.path.toLowerCase().includes(stem))) {
      file.score += 6;
      file.reasons.push("related test");
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  // A search hit inside executable code is stronger evidence than the same
  // words appearing only in comments. Inspect a bounded shortlist so this
  // signal does not turn context discovery into a full-repository read.
  const evidenceCandidates = ranked.slice(0, Math.min(24, maxFiles * 3));
  const evidenceSources = new Map<string, string>();
  await Promise.all(evidenceCandidates.map(async (file) => {
    const relative = path.relative(root, file.path);
    if (!IMPLEMENTATION_DIR.test(relative) ||
        /(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/i.test(relative)) return;
    const safe = await readBoundedFile(root, file.path);
    if (!safe || safe.oversized || safe.content.includes("\0")) return;
    evidenceSources.set(file.path, safe.content);
    const codeLines = safe.content.split(/\r?\n/)
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*|#)/.test(line));
    const code = codeLines.join("\n").toLowerCase();
    const covered = terms.filter((term) => includesTerm(code, term)).length;
    if (covered) {
      const strongestLine = codeLines.reduce((best, line) => {
        const lowered = line.toLowerCase();
        return Math.max(best, terms.filter((term) => includesTerm(lowered, term)).length);
      }, 0);
      file.score += Math.min(24, covered * 6) + strongestLine * 6;
      file.reasons.push(`matching ${covered} task terms in code; ${strongestLine} on one line`);
    }
  }));
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const shortlist = ranked.slice(0, maxFiles);
  if (maxFiles > 1 && !shortlist.some((file) => file.reasons.includes("related test"))) {
    const sourcePaths = shortlist.slice(0, maxFiles - 1)
      .filter((file) => !/(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/i.test(file.path));
    const relatedTest = ranked.find((file) => file.reasons.includes("related test") &&
      sourcePaths.some((source) => {
        const stem = path.basename(source.path).replace(CODE_EXTENSION, "").toLowerCase();
        return stem.length > 2 && file.path.toLowerCase().includes(stem);
      }));
    if (relatedTest && !shortlist.includes(relatedTest)) {
      shortlist.splice(maxFiles - 1, 1, relatedTest);
    }
  }
  const selected: string[] = [];
  // Keep the remaining ranked candidates as fallbacks if a file vanished
  // or changed type between ripgrep enumeration and file inspection.
  for (const file of [...shortlist, ...ranked.filter((candidate) => !shortlist.includes(candidate))]) {
    if (selected.length >= maxFiles) break;
    try {
      const stat = await fs.lstat(file.path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const real = await fs.realpath(file.path);
      if (!withinRoot(await fs.realpath(root), real)) continue;
    } catch { continue; }
    selected.push(file.path);
    result.files.push({ ...file, lines: await safeLines(root, file.path, terms) });
  }
  result.truncated ||= ranked.length > selected.length;
  if (selected.length < maxFiles) {
    const enumeratedSet = new Set(allCandidates);
    for (const owner of [...selected]) {
      if (selected.length >= maxFiles) break;
      const relative = path.relative(root, owner);
      if (!IMPLEMENTATION_DIR.test(relative) || /(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/i.test(relative)) continue;
      const cached = evidenceSources.get(owner);
      const source = cached === undefined ? await readBoundedFile(root, owner) : null;
      const content = cached ?? (source && !source.oversized ? source.content : "");
      if (!content || content.includes("\0")) continue;
      for (const dependency of directLocalImports(owner, content)) {
        if (selected.length >= maxFiles) break;
        if (!enumeratedSet.has(dependency) || selected.includes(dependency)) continue;
        const lines = await safeDependencyLines(root, dependency);
        if (!lines.length) continue;
        selected.push(dependency);
        result.files.push({ path: dependency, score: 0,
          reasons: [`direct local import from ${path.basename(owner)}`], lines });
      }
    }
  }
  result.instructions = await scopedInstructions(root, selected);
  if (ranked.length === 0) result.warnings.push("No matching source files found; inspect the repository manually");

  // Bound the serialized payload, not just the individual excerpt strings.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxChars) {
    result.truncated = true;
    const withLines = [...result.files].reverse().find((file) => file.lines.length > 0);
    if (withLines) { withLines.lines.pop(); continue; }
    if (result.instructions.length) { result.instructions.pop(); continue; }
    if (result.files.length) { result.files.pop(); continue; }
    if (result.warnings.length) { result.warnings.pop(); continue; }
    if (result.terms.length) { result.terms.pop(); continue; }
    break;
  }
  return result;
}