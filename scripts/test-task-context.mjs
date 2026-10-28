import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { buildTaskContext } from "../dist/lib/task-context.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-task-context-"));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`OK  ${name}`);
}

try {
  const root = path.join(temp, "repo");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(root, ".private"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), [
    "Use npm test for this repository.",
    "OPENAI_API_KEY=fixture_instruction_key_do_not_emit",
    '{"OPENAI_API_KEY":"fixture_json_secret_do_not_emit"}',
    "-----BEGIN PRIVATE KEY-----",
    "fixture_multiline_private_key_do_not_emit",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(root, "src", "AGENTS.md"), "Keep edits small and add regression tests.\n");
  await fs.writeFile(path.join(root, "src", "math.ts"), "export function computeInvoiceSplit(total) {\n  return Math.round(total);\n}\n");
  await fs.writeFile(path.join(root, "tests", "math.test.ts"), "import { computeInvoiceSplit } from '../src/math';\nexpect(computeInvoiceSplit(2.5)).toBe(3);\n");
  await fs.writeFile(path.join(root, "src", "payment-processor.ts"), "export function processPayment(amount) { return amount; }\n");
  await fs.writeFile(path.join(root, "src", "alpha.ts"), "// timeout child process cleanup is mentioned here but not implemented\n");
  await fs.writeFile(path.join(root, "src", "beta.ts"), "const timeout = true;\n" + "const irrelevant = 0;\n".repeat(20) + "const child = true;\n" + "const unrelated = 0;\n".repeat(20) + "const process = true;\n// cleanup mentioned here\n");
  await fs.writeFile(path.join(root, "src", "omega.ts"), "function stopChildProcessOnTimeout() { return true; }\n// cleanup after timeout\n");
  await fs.writeFile(path.join(root, "src", "task-context.ts"), "export function taskContextSearch() { /* task context search ignore */ }\n");
  await fs.writeFile(path.join(root, "app", "reconcile.py"), "def reconcile_invoice_duplicates():\n    return None\n");
  await fs.writeFile(path.join(root, "app", "instruction-loader.py"), "def load_instruction():\n    return 'loaded'\n");
  await fs.writeFile(path.join(root, "src", "report-render.ts"), "export function renderReport() { return 'report'; }\n");
  await fs.writeFile(path.join(root, "scripts", "reconcile-invoice-duplicates.mjs"), "const task = 'reconcile invoice duplicates';\n");
  await fs.writeFile(path.join(root, "scripts", "bench-task-context.mjs"), "const tasks = ['Improve task context search and ignore rules'];\n");
  await fs.writeFile(path.join(root, "src", "unrelated.ts"), "export const WORLD = true;\n");
  await fs.writeFile(path.join(root, "ignored.ts"), "computeInvoiceSplit in ignored file\n");
  await fs.writeFile(path.join(root, ".env"), "API_KEY=computeInvoiceSplit_secret_value\n");
  await fs.writeFile(path.join(root, "node_modules", "danger.ts"), "computeInvoiceSplit hidden value\n");
  await fs.writeFile(path.join(root, ".private", "danger.ts"), "computeInvoiceSplit hidden value\n");
  await fs.writeFile(path.join(root, "dist", "danger.ts"), "computeInvoiceSplit hidden value\n");
  await fs.writeFile(path.join(root, "src", "credentials.ts"), "const API_KEY = 'computeInvoiceSplit_secret_value';\n");
  await fs.writeFile(path.join(root, "src", "payment-large.ts"), "computeInvoiceSplit" + "X".repeat(200_000));
  const outside = path.join(temp, "outside.ts");
  await fs.writeFile(outside, "computeInvoiceSplit should not leak outside\n");
  let symlinkAvailable = false;
  try {
    await fs.symlink(outside, path.join(root, "src", "linked.ts"), "file");
    symlinkAvailable = true;
  } catch (error) {
    if (!(["EPERM", "EACCES", "ENOSYS"].includes(error.code))) throw error;
  }

  await test("task symbol finds implementation and nearby test despite unrelated filenames", async () => {
    const result = await buildTaskContext({ root, task: "Fix computeInvoiceSplit rounding errors" });
    const names = result.files.map((file) => file.path.replaceAll("\\", "/"));
    assert.ok(names.some((file) => file.endsWith("/src/math.ts")), JSON.stringify(names));
    assert.ok(names.some((file) => file.endsWith("/tests/math.test.ts")), JSON.stringify(names));
    assert.ok(names[0]?.endsWith("/src/math.ts"), "implementation should rank above a related test: " + JSON.stringify(names));
    assert.ok(result.files.some((file) => file.lines.some((line) => line.text.includes("computeInvoiceSplit"))));
    assert.ok(result.terms.includes("computeinvoicesplit"));
    assert.ok(result.instructions.some((entry) => entry.path.endsWith("AGENTS.md") && entry.content.includes("npm test")));
    assert.ok(result.instructions.some((entry) => entry.path.endsWith(path.join("src", "AGENTS.md")) && entry.content.includes("regression")));
    assert.ok(!JSON.stringify(result).includes("fixture_instruction_key_do_not_emit"), "scoped instructions must redact credential lines");
    assert.ok(!JSON.stringify(result).includes("fixture_json_secret_do_not_emit"), "JSON credentials must be redacted");
    assert.ok(!JSON.stringify(result).includes("fixture_multiline_private_key_do_not_emit"), "PEM bodies must be redacted");
  });

  await test("source snippets prefer the implementation line over repeated matching comments", async () => {
    const source = path.join(root, "src", "evidence-owner.ts");
    await fs.writeFile(source, [
      "// resolveLedgerEntry documented here",
      "// resolveLedgerEntry documented here",
      "// resolveLedgerEntry documented here",
      "export function resolveLedgerEntry() { return true; }",
    ].join("\n"));
    const result = await buildTaskContext({ root, task: "resolveLedgerEntry", maxFiles: 2 });
    const owner = result.files.find((file) => file.path === source);
    assert.ok(owner, "source owner missing");
    assert.ok(owner.lines.some((line) => line.text.includes("function resolveLedgerEntry")),
      "the first three repeated comments hid the source definition: " + JSON.stringify(owner.lines));
    assert.ok(new Set(owner.lines.map((line) => line.text.trim())).size === owner.lines.length,
      "duplicate source lines consumed the evidence budget");
  });

  await test("spare context slots include a direct local dependency with source evidence", async () => {
    const localRoot = path.join(temp, "dependency-context-repo");
    const sources = path.join(localRoot, "src");
    await fs.mkdir(sources, { recursive: true });
    const owner = path.join(sources, "forecast-owner.ts");
    const helper = path.join(sources, "currency-helper.ts");
    await fs.writeFile(owner, [
      'import { normalizeCurrency } from "./currency-helper.js";',
      'import "./private-helper.ts";',
      'export function calculateForecastNet(value) { return normalizeCurrency(value); }',
    ].join("\n"));
    await fs.writeFile(helper, [
      "const TOKEN = 'private_dependency_fixture_value';",
      "export function getInternalToken() { return 'indirect_function_secret_fixture'; }",
      "export function normalizeCurrency(value) { return Math.round(value); }",
    ].join("\n"));
    await fs.writeFile(path.join(localRoot, ".gitignore"), "src/private-helper.ts\n");
    await fs.writeFile(path.join(sources, "private-helper.ts"), "secret_source_should_not_appear\n");
    const result = await buildTaskContext({ root: localRoot, task: "calculateForecastNet", maxFiles: 3 });
    assert.equal(result.files[0]?.path, owner, "direct dependency must not displace the owner");
    const dependency = result.files.find((file) => file.path === helper);
    assert.ok(dependency, "nonmatching but directly imported helper omitted");
    assert.ok(dependency.lines.some((line) => line.text.includes("function normalizeCurrency")),
      "helper path without its source evidence does not help the model");
    assert.ok(!JSON.stringify(result).includes("private-helper.ts"));
    assert.ok(!JSON.stringify(result).includes("private_dependency_fixture_value"));
    assert.ok(!JSON.stringify(result).includes("indirect_function_secret_fixture"));
    const narrow = await buildTaskContext({ root: localRoot, task: "calculateForecastNet", maxFiles: 1 });
    assert.deepEqual(narrow.files.map((file) => file.path), [owner], "dependency exceeds maxFiles");
  });

  await test("CommonJS require resolves a local dependency without returning its initializer", async () => {
    const localRoot = path.join(temp, "commonjs-context-repo");
    const sources = path.join(localRoot, "src");
    await fs.mkdir(sources, { recursive: true });
    const owner = path.join(sources, "invoice-owner.cjs");
    const helper = path.join(sources, "rounding.cjs");
    await fs.writeFile(owner, [
      'const { roundMoney } = require("./rounding.cjs");',
      'exports.calculateInvoiceNet = (amount, fee) => roundMoney(amount - fee);',
    ].join("\n"));
    await fs.writeFile(helper, [
      "exports.roundMoney = (value) => Math.round(value * 100) / 100;",
      "exports.unrelated = 'indirect_commonjs_secret_fixture';",
    ].join("\n"));
    const result = await buildTaskContext({ root: localRoot, task: "calculateInvoiceNet", maxFiles: 3 });
    assert.equal(result.files[0]?.path, owner);
    const dependency = result.files.find((file) => file.path === helper);
    assert.ok(dependency, "CommonJS dependency omitted");
    assert.ok(dependency.lines.some((line) => line.text.includes("roundMoney")), "CommonJS export evidence omitted");
    assert.ok(!JSON.stringify(result).includes("indirect_commonjs_secret_fixture"));
  });

  await test("task_context never exposes a matched line inside a multiline private key", async () => {
    const source = path.join(root, "src", "embedded-key.ts");
    await fs.writeFile(source, [
      "export const harmless = 1;",
      "-----BEGIN PRIVATE KEY-----",
      "SECRET_KEY_PAYLOAD_FIXTURE_TOKEN",
      "-----END PRIVATE KEY-----",
    ].join("\n"));
    const result = await buildTaskContext({ root, task: "SECRET_KEY_PAYLOAD_FIXTURE_TOKEN", maxFiles: 1 });
    const owner = result.files.find((file) => file.path === source);
    assert.ok(owner, "fixture source was not discovered");
    assert.ok(owner.lines.every((line) => !line.text.includes("SECRET_KEY_PAYLOAD_FIXTURE_TOKEN")),
      "private key body returned as a source snippet: " + JSON.stringify(owner.lines));
  });

  await test("filename relevance correctly selects another feature", async () => {
    const result = await buildTaskContext({ root, task: "Change payment processor handling" });
    assert.ok(result.files[0]?.path.endsWith("payment-processor.ts"), JSON.stringify(result.files.map((file) => file.path)));
  });

  await test("multiple matching task terms outrank incidental single-word matches", async () => {
    const result = await buildTaskContext({ root, task: "timeout child process cleanup" });
    assert.ok(result.files[0]?.path.endsWith("omega.ts"), "scattered identifiers must not outrank a matching implementation symbol: " + JSON.stringify(result.files.map((file) => ({ path: file.path, score: file.score }))));
  });

  await test("implementation outranks a benchmark that merely repeats the task description", async () => {
    const result = await buildTaskContext({ root, task: "Improve task context search and ignore rules" });
    assert.ok(result.files[0]?.path.endsWith(path.join("src", "task-context.ts")),
      JSON.stringify(result.files.map((file) => ({ path: file.path, score: file.score }))));
  });

  await test("non-src application code outranks a task-named benchmark script", async () => {
    const result = await buildTaskContext({ root, task: "reconcile invoice duplicates" });
    assert.ok(result.files[0]?.path.endsWith(path.join("app", "reconcile.py")),
      JSON.stringify(result.files.map((file) => ({ path: file.path, score: file.score }))));
  });

  await test("plural filenames and gerund verbs resolve to their source names", async () => {
    const reports = await buildTaskContext({ root, task: "rendering reports" });
    assert.ok(reports.files[0]?.path.endsWith(path.join("src", "report-render.ts")),
      JSON.stringify(reports.files.map((file) => file.path)));
    const instructions = await buildTaskContext({ root, task: "loading instructions" });
    assert.ok(instructions.files[0]?.path.endsWith(path.join("app", "instruction-loader.py")),
      JSON.stringify(instructions.files.map((file) => file.path)));
  });

  await test("crowded matches retain the actual implementation and its related test", async () => {
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(root, "src", `mention-${i}.ts`), "// computeInvoiceSplit is referenced here\n");
    }
    const result = await buildTaskContext({ root, task: "computeInvoiceSplit", maxFiles: 6 });
    const names = result.files.map((file) => file.path.replaceAll("\\", "/"));
    assert.ok(names.some((name) => name.endsWith("/src/math.ts")), "implementation omitted: " + JSON.stringify(names));
    assert.ok(names.some((name) => name.endsWith("/tests/math.test.ts")), "matching regression test omitted: " + JSON.stringify(names));
  });

  await test("ignored, hidden, generated, credential and symlink paths never appear", async () => {
    const result = await buildTaskContext({ root, task: "Fix computeInvoiceSplit API_KEY" });
    const names = result.files.map((file) => file.path.replaceAll("\\", "/"));
    assert.ok(names.every((name) => !/(ignored|node_modules|\.private|\/dist\/|\.env|credentials|linked\.ts)/i.test(name)), JSON.stringify(names));
    assert.ok(!JSON.stringify(result).includes("computeInvoiceSplit_secret_value"));
    assert.ok(!JSON.stringify(result).includes("should not leak outside"));
    if (symlinkAvailable) console.log("OK  symlink exclusion exercised on this platform");
  });

  await test("response is deterministic and bounded on long lines", async () => {
    const options = { root, task: "computeInvoiceSplit", maxFiles: 2, maxChars: 1800 };
    const first = await buildTaskContext(options);
    const second = await buildTaskContext(options);
    assert.deepEqual(second, first);
    assert.ok(first.files.length <= 2);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1800, "payload exceeded maxChars");
    assert.ok(first.files.every((file) => file.lines.every((line) => line.text.length <= 220)));
  });

  await test("oversized instruction files are not read into the task response", async () => {
    const instruction = path.join(root, "src", "CLAUDE.md");
    await fs.writeFile(instruction, "Large instruction body.\n".repeat(9000));
    const result = await buildTaskContext({ root, task: "computeInvoiceSplit" });
    const item = result.instructions.find((entry) => entry.path === instruction);
    assert.ok(item?.truncated, "oversized instruction must be explicitly truncated");
    assert.match(item.content, /too large|oversize|read manually/i, "do not read a large instruction merely to return 800 bytes");
  });

  await test("missing ripgrep safely fails closed with an explicit warning", async () => {
    const previous = process.env.LOCAL_CODER_RG_BIN;
    try {
      process.env.LOCAL_CODER_RG_BIN = "__missing_rg_for_test__";
      const result = await buildTaskContext({ root, task: "computeInvoiceSplit" });
      assert.ok(result.warnings.some((message) => /ripgrep/i.test(message)), JSON.stringify(result.warnings));
      assert.deepEqual(result.files, [], "without ignore-aware search, don't traverse possibly ignored private files");
    } finally {
      if (previous === undefined) delete process.env.LOCAL_CODER_RG_BIN;
      else process.env.LOCAL_CODER_RG_BIN = previous;
    }
  });

  await test("non-ASCII queries retain ignore-aware ripgrep matching", async () => {
    await fs.writeFile(path.join(root, "src", "ukrainian.ts"), "export const рахунок_оплачено = true;\n");
    const result = await buildTaskContext({ root, task: "рахунок_оплачено" });
    assert.ok(result.files.some((file) => file.path.endsWith(path.join("src", "ukrainian.ts"))));
  });

  await test("large candidate sets preserve content search and nested ignore rules", async () => {
    const largeRoot = path.join(temp, "large-repo");
    const sources = path.join(largeRoot, "src");
    await fs.mkdir(sources, { recursive: true });
    await fs.writeFile(path.join(sources, ".gitignore"), "hidden-owner.ts\n");
    await fs.writeFile(path.join(sources, "a-owner.ts"), "export const distinctCrawlerSignal = true;\n");
    await fs.writeFile(path.join(sources, "z-tail.ts"), "export const lateBoundaryToken = true;\n");
    await fs.writeFile(path.join(sources, "hidden-owner.ts"), "export const distinctCrawlerSignal = true;\n");
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 4100 - start) }, (_, i) =>
        fs.writeFile(path.join(sources, `filler-${String(start + i).padStart(5, "0")}.ts`),
          "export const filler = 1;\n")));
    }
    const result = await buildTaskContext({ root: largeRoot, task: "distinctCrawlerSignal" });
    assert.ok(result.searched_files > 96, "must exercise the large-repository search path");
    assert.ok(result.files[0]?.path.endsWith(path.join("src", "a-owner.ts")));
    assert.ok(!result.files.some((file) => file.path.endsWith("hidden-owner.ts")));
    const late = await buildTaskContext({ root: largeRoot, task: "lateBoundaryToken" });
    assert.ok(late.files.some((file) => file.path.endsWith(path.join("src", "z-tail.ts"))),
      "late source omitted after candidate limit: " + JSON.stringify({ searched: late.searched_files, warnings: late.warnings }));
  });

  await test("rare multi-term search uses one actual content scan while retaining late owner and ignores", async () => {
    const searchRoot = path.join(temp, "multi-term-owner-repo");
    const sources = path.join(searchRoot, "src");
    await fs.mkdir(sources, { recursive: true });
    await fs.writeFile(path.join(searchRoot, ".gitignore"), "src/ignored.ts\n");
    await fs.writeFile(path.join(sources, "z-owner.ts"),
      "export function ledgerSyncingTokenExpiry() { return true; }\n");
    await fs.writeFile(path.join(sources, "ignored.ts"),
      "export function ledgerSyncingTokenExpiry() { return 'ignored'; }\n");
    for (let i = 0; i < 120; i++) {
      await fs.writeFile(path.join(sources, `middle-${String(i).padStart(3, "0")}.ts`),
        "export const genericValue = true;\n");
    }
    const realExecFile = childProcess.execFile;
    const launched = [];
    const observedExecFile = function (...args) {
      launched.push(args[1]);
      return realExecFile.apply(this, args);
    };
    observedExecFile[promisify.custom] = (...args) => {
      launched.push(args[1]);
      return promisify(realExecFile)(...args);
    };
    childProcess.execFile = observedExecFile;
    syncBuiltinESMExports();
    try {
      const { buildTaskContext: instrumented } = await import("../dist/lib/task-context.js?one-scan-probe");
      const result = await instrumented({ root: searchRoot, task: "ledger syncing token expiry" });
      assert.ok(result.files[0]?.path.endsWith(path.join("src", "z-owner.ts")),
        "real late owner missing: " + JSON.stringify({ files: result.files.map((file) => file.path),
          warnings: result.warnings, runs: launched.length }));
      assert.ok(!result.files.some((file) => file.path.endsWith("ignored.ts")));
      const contentScans = launched.filter((args) => args?.includes("--files-with-matches")).length;
      assert.equal(contentScans, 1, `expected one content scan for four rare terms, observed ${contentScans}`);
    } finally {
      childProcess.execFile = realExecFile;
      syncBuiltinESMExports();
    }
  });

  await test("clustered multi-term overflow aborts the union scan and retains ignore-safe results", async () => {
    const largeRoot = path.join(temp, "large-repo");
    const sources = path.join(largeRoot, "src");
    await Promise.all(Array.from({ length: 140 }, (_, i) =>
      fs.writeFile(path.join(sources, `filler-${String(100 + i).padStart(5, "0")}.ts`),
        "export const clusteredBurstToken = true;\n")));
    const realExecFile = childProcess.execFile;
    let groupedScans = 0;
    let earlyStops = 0;
    const watched = function (...args) {
      return realExecFile.apply(this, args);
    };
    watched[promisify.custom] = async (...args) => {
      const grouped = args[1]?.filter((arg) => arg === "--regexp").length === 4;
      if (grouped) groupedScans++;
      try {
        return await promisify(realExecFile)(...args);
      } catch (error) {
        if (grouped && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") earlyStops++;
        throw error;
      }
    };
    childProcess.execFile = watched;
    syncBuiltinESMExports();
    try {
      const { buildTaskContext: instrumented } = await import("../dist/lib/task-context.js?early-abort-probe");
      const result = await instrumented({ root: largeRoot,
        task: "clusteredBurstToken lateBoundaryToken missingA missingB" });
      assert.equal(groupedScans, 1, "expected one combined search probe");
      assert.equal(earlyStops, 1, "large union must stop on the bounded stdout budget");
      assert.ok(result.files.every((file) => !file.path.endsWith("hidden-owner.ts")));
    } finally {
      childProcess.execFile = realExecFile;
      syncBuiltinESMExports();
    }
  });

  await test("a rare task term is represented when common content fills the top results", async () => {
    const result = await buildTaskContext({ root: path.join(temp, "large-repo"),
      task: "clusteredBurstToken lateBoundaryToken missingA missingB", maxFiles: 6 });
    assert.ok(result.files.some((file) => file.path.endsWith("filler-00100.ts")),
      "a common term must still contribute context");
    assert.ok(result.files.some((file) => file.path.endsWith("z-tail.ts")),
      "the only match for a rare term must not be buried by 140 tied common files");
  });

  await test("tool exposure tasks favor registered handlers over repeated catalog descriptions", async () => {
    const ownerRoot = path.join(temp, "tool-owner-repo");
    const toolsDir = path.join(ownerRoot, "src", "tools");
    const libDir = path.join(ownerRoot, "src", "lib");
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(toolsDir, "io.ts"), [
      "export function registerFilesystemTools(server) {",
      "  server.registerTool(\"read_text_file\", {}, async () => 'contents');",
      "  server.registerTool(\"write_file\", {}, async () => 'saved');",
      "}",
    ].join("\n"));
    for (const name of ["catalog", "prompt", "config"]) {
      await fs.writeFile(path.join(libDir, `${name}.ts`), [
        "export const description = 'expose read write';",
        "export const operations = ['read_text_file', 'write_file'];",
      ].join("\n"));
    }
    const result = await buildTaskContext({ root: ownerRoot, task: "Expose file read and write operations", maxFiles: 3 });
    assert.ok(result.files.some((file) => file.path.endsWith(path.join("tools", "io.ts"))),
      "registrar missing from top three: " + JSON.stringify(result.files.map((file) => ({ path: file.path, score: file.score }))));
  });

  await test("invalid task is rejected before scanning", async () => {
    await assert.rejects(buildTaskContext({ root, task: "   " }), /task/i);
  });

  console.log(`\n${passed} passed, 0 failed`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}