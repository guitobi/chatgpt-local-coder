import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { globFiles } from "../dist/lib/glob-search.js";
import { grepSearch } from "../dist/lib/grep-search.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, isMultiFilePatch } from "../dist/lib/patch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp");

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

await fs.mkdir(tmpDir, { recursive: true });

await run("glob finds typescript files", async () => {
  const matches = await globFiles(root, "src/**/*.ts", 50);
  if (!matches.some((m) => m.path.endsWith("filesystem.ts"))) throw new Error("filesystem.ts not found");
});

await run("grep content mode", async () => {
  const out = await grepSearch({ pattern: "registerFilesystemTools", path: path.join(root, "src"), glob: "*.ts", headLimit: 10 });
  if (!out.includes("filesystem.ts")) throw new Error("pattern not found");
});

await run("grep files_with_matches mode", async () => {
  const out = await grepSearch({
    pattern: "createMcpServer",
    path: path.join(root, "src"),
    glob: "*.ts",
    outputMode: "files_with_matches",
    headLimit: 10,
  });
  if (!out.includes("server-factory")) throw new Error("file not listed");
});

await run("grep searches a single file in every output mode", async () => {
  const dir = path.join(tmpDir, "single file & [special]");
  const file = path.join(dir, "source.txt");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "first\nneedle found\nlast\n", "utf8");
  const options = { pattern: "needle", path: file, glob: "*.txt" };
  const content = await grepSearch(options);
  if (content !== `${file}:2: needle found`) throw new Error(`content: ${content}`);
  const files = await grepSearch({ ...options, outputMode: "files_with_matches" });
  if (files !== file) throw new Error(`files: ${files}`);
  const count = await grepSearch({ ...options, outputMode: "count" });
  if (count !== `${file}:1`) throw new Error(`count: ${count}`);
  const excluded = await grepSearch({ ...options, glob: "*.ts" });
  if (excluded !== "No matches found") throw new Error(`glob: ${excluded}`);
  const absent = await grepSearch({ ...options, pattern: "not-present" });
  if (absent !== "No matches found") throw new Error(`absent: ${absent}`);
});

await run("grep falls back when ripgrep is unavailable or regex is unsupported", async () => {
  const file = path.join(tmpDir, "fallback.txt");
  await fs.writeFile(file, "alpha needle\nsecond line\n", "utf8");
  const previous = process.env.LOCAL_CODER_RG_BIN;
  process.env.LOCAL_CODER_RG_BIN = "missing-ripgrep-executable-for-test";
  try {
    const out = await grepSearch({ pattern: "needle", path: file });
    if (out !== `${file}:1: alpha needle`) throw new Error(`missing binary: ${out}`);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_CODER_RG_BIN;
    else process.env.LOCAL_CODER_RG_BIN = previous;
  }
  const lookbehind = await grepSearch({ pattern: "(?<=alpha )needle", path: file });
  if (lookbehind !== `${file}:1: alpha needle`) throw new Error(`lookbehind: ${lookbehind}`);
});

await run("grep preserves context and multiline behavior", async () => {
  const file = path.join(tmpDir, "context.txt");
  await fs.writeFile(file, "before\nMATCH\nafter\n", "utf8");
  const context = await grepSearch({ pattern: "MATCH", path: file, contextAround: 1 });
  const expected = `${file}-1: before\n${file}:2: MATCH\n${file}-3: after`;
  if (context !== expected) throw new Error(`context: ${context}`);
  const multi = await grepSearch({ pattern: "^MATCH$", path: file, multiline: true });
  if (multi !== `${file}: [multiline match x1]`) throw new Error(`multiline: ${multi}`);
});

await run("grep preserves directory exclusions, line counts and case folding", async () => {
  const root = path.join(tmpDir, "grep-tree");
  const source = path.join(root, "src", "main.ts");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
  await fs.writeFile(source, "NEEDLE one\nneedle two\nno hit\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "other.ts"), "NEEDLE hidden dependency\n");
  await fs.writeFile(path.join(root, ".hidden", "secret.ts"), "NEEDLE hidden file\n");

  const args = { pattern: "needle", path: root, glob: "*.ts", caseInsensitive: true };
  const counts = await grepSearch({ ...args, outputMode: "count" });
  if (counts !== `${source}:2`) throw new Error(`count: ${counts}`);
  const contents = await grepSearch({ ...args, headLimit: 1 });
  if (contents !== `${source}:1: NEEDLE one`) throw new Error(`limit: ${contents}`);

  const upper = path.join(root, "src", "CAPS.TS");
  await fs.writeFile(upper, "extensionCaseMarker\n", "utf8");
  const extensionCase = await grepSearch({ pattern: "extensionCaseMarker", path: root, glob: "*.ts" });
  if (extensionCase !== `${upper}:1: extensionCaseMarker`) throw new Error(`case-insensitive glob: ${extensionCase}`);
});

await run("apply_patch codex style", async () => {
  const file = path.join(tmpDir, "sample.txt");
  await fs.writeFile(file, "hello\nworld\n");
  const next = applyUnifiedPatchToText("hello\nworld\n", "@@\n-hello\n+hi\n world\n");
  if (!next.includes("hi")) throw new Error("patch failed");
});

await run("read offset/limit simulation", async () => {
  const file = path.join(tmpDir, "lines.txt");
  await fs.writeFile(file, "a\nb\nc\nd\n");
  const lines = (await fs.readFile(file, "utf-8")).split("\n");
  const slice = lines.slice(1, 3);
  if (slice.join(",") !== "b,c") throw new Error(`unexpected ${slice}`);
});

await run("edit replace_all simulation", async () => {
  const file = path.join(tmpDir, "repeat.txt");
  await fs.writeFile(file, "foo bar foo");
  const content = await fs.readFile(file, "utf-8");
  const next = content.split("foo").join("baz");
  await fs.writeFile(file, next);
  const result = await fs.readFile(file, "utf-8");
  if (result !== "baz bar baz") throw new Error(result);
});

await run("multi-file patch detection", async () => {
  const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-hello
+hi
*** End Patch`;
  if (!isMultiFilePatch(patch)) throw new Error("should detect multi-file patch");
});

await run("multi-file patch apply", async () => {
  const file = path.join(tmpDir, "multi.txt");
  await fs.writeFile(file, "alpha\nbeta\n");
  const patch = `*** Begin Patch
*** Update File: multi.txt
@@
-alpha
+gamma
 beta
*** End Patch`;
  const results = await applyMultiFilePatch(patch, { base_dir: tmpDir });
  if (results.length !== 1 || !results[0].ok) throw new Error(JSON.stringify(results));
  const text = await fs.readFile(file, "utf-8");
  if (!text.includes("gamma")) throw new Error(text);
});

await run("delete and move file", async () => {
  const src = path.join(tmpDir, "move-me.txt");
  const dest = path.join(tmpDir, "moved.txt");
  await fs.writeFile(src, "payload");
  await fs.rename(src, dest);
  const text = await fs.readFile(dest, "utf-8");
  if (text !== "payload") throw new Error("move failed");
  await fs.unlink(dest);
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);