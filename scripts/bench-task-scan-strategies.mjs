import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { constants as fsConstants } from "node:fs";

// Read-only exploratory spike on local source files. No model, API, tunnel or writes.
const root = process.cwd();
const run = promisify(execFile);
const codeType = "taskcode:*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,vue,svelte,rb,php,sql,sh,ps1}";
const args = ["--no-require-git", "--no-messages", "--type-add", codeType, "--type", "taskcode"];
const tasks = [
  ["timeout", "child", "process", "cleanup"],
  ["task", "context", "search", "ignore", "rules"],
  ["checkpoint", "edit", "verify", "complete"],
];
const scans = { enumerate: [], ripgrep_terms: [], local_files: [], secure_files: [] };
let scannedFiles = 0;
let scannedBytes = 0;

async function readSecure(file) {
  try {
    for (let folder = path.dirname(file); folder.startsWith(root); folder = path.dirname(folder)) {
      const parent = await fs.lstat(folder);
      if (!parent.isDirectory() || parent.isSymbolicLink()) return "";
      if (folder === root) break;
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return "";
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    if (path.relative(realRoot, realFile).startsWith("..")) return "";
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      const named = await fs.lstat(file);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
        opened.dev !== stat.dev || opened.ino !== stat.ino ||
        named.dev !== stat.dev || named.ino !== stat.ino || opened.size > 128 * 1024) return "";
      const bytes = Buffer.alloc(opened.size);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      return bytes.subarray(0, used).toString("utf8");
    } finally { await handle.close(); }
  } catch { return ""; }
}

for (let i = 0; i < 12; i++) {
  const terms = tasks[i % tasks.length];
  let start = performance.now();
  const { stdout } = await run("rg", ["--files", "--sort", "path", ...args, "--", root],
    { cwd: root, windowsHide: true, timeout: 7000, maxBuffer: 2 * 1024 * 1024 });
  const names = stdout.split(/\r?\n/).filter(Boolean).map((file) => path.resolve(root, file));
  scans.enumerate.push(performance.now() - start);

  start = performance.now();
  await Promise.all(terms.map(async (term) => {
    try {
      await run("rg", ["--files-with-matches", "--fixed-strings", "--ignore-case", "--max-filesize", "128K",
        ...args, "--regexp", term, "--", root],
      { cwd: root, windowsHide: true, timeout: 7000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  }));
  scans.ripgrep_terms.push(performance.now() - start);

  start = performance.now();
  const contents = await Promise.all(names.map(async (file) => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024) return "";
    return fs.readFile(file, "utf8");
  }));
  scans.local_files.push(performance.now() - start);
  start = performance.now();
  await Promise.all(names.map(readSecure));
  scans.secure_files.push(performance.now() - start);
  scannedFiles = names.length;
  scannedBytes = contents.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
}
const report = Object.fromEntries(Object.entries(scans).map(([step, timings]) => {
  const sorted = timings.slice(2).sort((a, b) => a - b);
  return [step, { p50_ms: Number(sorted[Math.ceil(sorted.length / 2) - 1].toFixed(1)),
    p95_ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1)) }];
}));
console.log("BENCH scan strategies", JSON.stringify({ files: scannedFiles, bytes: scannedBytes, ...report }));