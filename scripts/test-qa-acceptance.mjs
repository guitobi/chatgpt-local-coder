import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Real MCP calls to a disposable localhost-only server and synthetic files.
// No model, remote tunnel, upstream connector, or paid API is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-qa-acceptance-"));
const project = path.join(temp, "synthetic-project");
const token = randomBytes(24).toString("base64url");
let server;
let client;
let serverLogs = "";
const results = [];

async function write(relative, content) {
  const file = path.join(project, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}
function location(relative) {
  return path.join(project, relative);
}
function argv(...argumentsList) {
  return JSON.stringify(argumentsList);
}
function data(reply) {
  return reply.structuredContent?.data;
}
function ok(reply) {
  assert.equal(reply.structuredContent?.ok, true, JSON.stringify(reply.structuredContent).slice(0, 1100));
  return data(reply);
}
async function call(name, argumentsObject) {
  return client.callTool({ name, arguments: argumentsObject });
}
async function test(name, fn) {
  const started = Date.now();
  await fn();
  results.push({ scenario: name, status: "PASS", elapsed_ms: Date.now() - started });
  console.log("PASS " + results.length + "/10 " + name);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function ready(base) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("QA server stopped: " + serverLogs.slice(-1000));
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("QA server health timeout: " + serverLogs.slice(-1000));
}

try {
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(temp, "empty-upstream.json"), '{"version":1,"servers":[]}', "utf8");
  await fs.writeFile(path.join(temp, "empty.env"), "", "utf8");
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const cleanEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "CI"]) {
    if (process.env[key] !== undefined) cleanEnv[key] = process.env[key];
  }
  server = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...cleanEnv,
      DOTENV_CONFIG_PATH: path.join(temp, "empty.env"),
      HOST: "127.0.0.1", PORT: String(port), ADMIN_PORT: String(adminPort),
      MCP_TOKEN: token, WORKSPACE_PATH: project, CHATGPT_TOOL_PROFILE: "slim",
      MCP_UPSTREAM_CONFIG: path.join(temp, "empty-upstream.json"),
      CHECKPOINT_PATH: path.join(temp, "checkpoints"),
      MCP_SHELL_STATE_DIR: path.join(temp, "shell-state"),
      AUDIT_LOG_PATH: path.join(temp, "audit.log"),
      POST_EDIT_HOOKS_CONFIG: path.join(temp, "missing-hooks.json"),
    },
  });
  server.stdout.on("data", (chunk) => (serverLogs += chunk.toString()));
  server.stderr.on("data", (chunk) => (serverLogs += chunk.toString()));
  const base = "http://127.0.0.1:" + port;
  await ready(base);
  client = new Client({ name: "offline-qa-acceptance", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/" + token)));

  await test("real failing test -> relevant context -> single-file repair -> passing test", async () => {
    const dir = "single";
    const source = await write(dir + "/src/calculator.cjs", "exports.calculateSubtotal = (a, b) => a - b;\n");
    const testFile = await write(dir + "/tests/calculator.test.cjs", [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const { calculateSubtotal } = require("../src/calculator.cjs");',
      'test("sum", () => assert.equal(calculateSubtotal(2, 3), 5));',
      "",
    ].join("\n"));
    const command = argv(process.execPath, "--test", testFile);
    const failure = await call("diagnose_failure", { path: location(dir), command, command_mode: "argv" });
    assert.equal(failure.structuredContent?.ok, false, "original regression must fail");
    const context = ok(await call("task_context", { path: location(dir), task: "Fix calculateSubtotal" }));
    assert.ok(context.files.some((file) => file.path === source));
    assert.ok(context.files.some((file) => file.path === testFile));
    const edit = ok(await call("edit_and_verify", {
      path: source, patch: "@@\n-exports.calculateSubtotal = (a, b) => a - b;\n+exports.calculateSubtotal = (a, b) => a + b;",
      command, command_mode: "argv", working_directory: location(dir),
    }));
    assert.equal(edit.verification?.exit_code, 0);
    assert.match(edit.patch?.checkpoint_id, /^cp_/);
  });

  await test("direct dependency discovered, safe two-file fix verified", async () => {
    const dir = "dependent";
    const owner = await write(dir + "/src/invoice-owner.cjs",
      'const { roundMoney } = require("./rounding.cjs");\nexports.calculateInvoiceNet = (amount, fee) => roundMoney(amount + fee);\n');
    const helper = await write(dir + "/src/rounding.cjs", "exports.roundMoney = (value) => Math.floor(value);\n");
    const check = await write(dir + "/tests/invoice.test.cjs", [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const { calculateInvoiceNet } = require("../src/invoice-owner.cjs");',
      'test("net after fee", () => assert.equal(calculateInvoiceNet(10.129, 1), 9.13));',
    ].join("\n"));
    const context = ok(await call("task_context", { path: location(dir), task: "calculateInvoiceNet", max_files: 4 }));
    assert.equal(context.files[0]?.path, owner);
    assert.ok(context.files.some((file) => file.path === helper && file.lines.some((line) => line.text.includes("roundMoney"))));
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/invoice-owner.cjs",
      "@@",
      "-exports.calculateInvoiceNet = (amount, fee) => roundMoney(amount + fee);",
      "+exports.calculateInvoiceNet = (amount, fee) => roundMoney(amount - fee);",
      "*** Update File: src/rounding.cjs",
      "@@",
      "-exports.roundMoney = (value) => Math.floor(value);",
      "+exports.roundMoney = (value) => Math.round(value * 100) / 100;",
      "*** End Patch",
    ].join("\n");
    const before = await fs.readFile(owner, "utf8");
    const preview = ok(await call("apply_patch", { path: location(dir), patch, safe: true, dry_run: true }));
    assert.equal(preview.files.length, 2);
    assert.equal(await fs.readFile(owner, "utf8"), before, "preview must not write");
    const applied = ok(await call("apply_patch", { path: location(dir), patch, safe: true }));
    assert.match(applied.checkpoint_id, /^cp_/);
    const verification = ok(await call("diagnose_failure", {
      path: location(dir), command: argv(process.execPath, "--test", check), command_mode: "argv",
    }));
    assert.equal(verification.exit_code, 0);
  });

  await test("duplicate symbol names return implementation before archive", async () => {
    const dir = "duplicate";
    const owner = await write(dir + "/src/roster.cjs", "exports.getRosterStatus = () => 'active';\n");
    await write(dir + "/docs/old-roster.cjs", "// getRosterStatus deprecated\nexports.getRosterStatus = () => 'retired';\n");
    const context = ok(await call("task_context", { path: location(dir), task: "Fix getRosterStatus in active roster" }));
    assert.equal(context.files[0]?.path, owner);
  });

  await test("misleading repeated comments do not hide actual function definition", async () => {
    const dir = "misleading";
    const owner = await write(dir + "/src/ledger.cjs", [
      "// resolveLedgerEntry mentioned here",
      "// resolveLedgerEntry mentioned here",
      "// resolveLedgerEntry mentioned here",
      "exports.resolveLedgerEntry = (id) => id;",
      "",
    ].join("\n"));
    const context = ok(await call("task_context", { path: location(dir), task: "resolveLedgerEntry" }));
    const file = context.files.find((entry) => entry.path === owner);
    assert.ok(file?.lines.some((line) => line.text.includes("exports.resolveLedgerEntry =")));
  });

  await test("larger synthetic repository preserves relevant owner and bounded payload", async () => {
    const dir = "large";
    for (let i = 0; i < 320; i++) {
      await write(dir + "/src/noise-" + i + ".js", "exports.unrelated" + i + " = " + i + ";\n");
    }
    const owner = await write(dir + "/src/rare-charge.js", "exports.computeRareCharge = (value) => value;\n");
    const context = ok(await call("task_context", {
      path: location(dir), task: "Fix computeRareCharge", max_files: 3, max_chars: 3000,
    }));
    assert.equal(context.files[0]?.path, owner);
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 3000);
    assert.ok(context.searched_files >= 320);
  });

  await test("ignored files and synthetic secrets never appear in search responses", async () => {
    const dir = "privacy";
    const marker = "SYNTHETIC_PRIVATE_FIXTURE_123";
    await write(dir + "/.gitignore", "ignored.js\n");
    const owner = await write(dir + "/src/tax.js", "exports.calculateMaskedTax = (value) => value;\n");
    await write(dir + "/ignored.js", "calculateMaskedTax " + marker + "\n");
    await write(dir + "/.env", "API_KEY=" + marker + "\n");
    await write(dir + "/node_modules/opaque.js", "calculateMaskedTax " + marker + "\n");
    await write(dir + "/src/credentials.js", "exports.calculateMaskedTax = '" + marker + "';\n");
    const matches = ok(await call("inspect_code", { path: location(dir), query: "calculateMaskedTax" }));
    const context = ok(await call("task_context", { path: location(dir), task: "calculateMaskedTax" }));
    assert.ok(matches.matches.some((entry) => entry.path === owner));
    assert.equal(context.files[0]?.path, owner);
    assert.ok(!JSON.stringify({ matches, context }).includes(marker));
  });

  await test("failing command returns file and line diagnostics", async () => {
    const dir = "failure";
    await write(dir + "/src/payment.js", "exports.pay = () => false;\n");
    const failure = await call("diagnose_failure", {
      path: location(dir), command_mode: "argv",
      command: argv(process.execPath, "-e", "console.error('src/payment.js:4:9: payment assertion failed');process.exit(9)"),
    });
    assert.equal(failure.structuredContent?.ok, false);
    assert.equal(data(failure)?.exit_code, 9);
    assert.ok(data(failure)?.locations.some((entry) => entry.path === "src/payment.js" && entry.line === 4));
  });

  await test("local TypeScript compiler error yields a structured location", async () => {
    const dir = "compile";
    await write(dir + "/tsconfig.json", '{"compilerOptions":{"strict":true,"noEmit":true},"files":["broken.ts"]}');
    await write(dir + "/broken.ts", 'const count: number = "not a number";\n');
    const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
    const failure = await call("diagnose_failure", {
      path: location(dir), command_mode: "argv",
      command: argv(process.execPath, compiler, "-p", location(dir), "--pretty", "false"),
    });
    assert.equal(failure.structuredContent?.ok, false, "invalid TypeScript must fail");
    assert.ok(data(failure)?.locations.some((entry) => /broken\.ts$/i.test(entry.path) && entry.line === 1),
      JSON.stringify(data(failure)?.locations));
  });

  await test("stale second hunk blocks the entire multi-file transaction", async () => {
    const dir = "conflict";
    const first = await write(dir + "/first.js", "const FIRST = 1;\n");
    const second = await write(dir + "/second.js", "const SECOND = 7;\n");
    const patch = [
      "*** Begin Patch", "*** Update File: first.js", "@@", "-const FIRST = 1;", "+const FIRST = 2;",
      "*** Update File: second.js", "@@", "-const SECOND = 8;", "+const SECOND = 9;", "*** End Patch",
    ].join("\n");
    const rejected = await call("apply_patch", { path: location(dir), patch, safe: true });
    assert.equal(rejected.isError, true, "stale patch unexpectedly accepted");
    assert.match(JSON.stringify(rejected), /context|mismatch|expected/i);
    assert.equal(await fs.readFile(first, "utf8"), "const FIRST = 1;\n");
    assert.equal(await fs.readFile(second, "utf8"), "const SECOND = 7;\n");
  });

  await test("failed verification retains checkpoint and rewind restores source", async () => {
    const dir = "rollback";
    const source = await write(dir + "/status.js", "const STATUS = 1;\n");
    const edit = await call("edit_and_verify", {
      path: source,
      patch: "@@\n-const STATUS = 1;\n+const STATUS = 2;",
      command: argv(process.execPath, "-e", "process.exit(7)"),
      command_mode: "argv", working_directory: location(dir),
    });
    assert.equal(edit.structuredContent?.ok, false);
    const checkpoint = data(edit)?.patch?.checkpoint_id;
    assert.match(checkpoint, /^cp_/);
    assert.equal(await fs.readFile(source, "utf8"), "const STATUS = 2;\n");
    const preview = ok(await call("rewind", { action: "preview", checkpoint_id: checkpoint }));
    assert.ok(preview.changes.length >= 1);
    ok(await call("rewind", { action: "restore", checkpoint_id: checkpoint }));
    assert.equal(await fs.readFile(source, "utf8"), "const STATUS = 1;\n");
  });

  assert.equal(results.length, 10);
  console.log("\nQA acceptance: 10/10 passed. Disposable HTTP MCP session; no model evaluation.");
} finally {
  await client?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  await fs.rm(temp, { recursive: true, force: true });
}