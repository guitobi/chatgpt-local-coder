import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-http-e2e-"));
const project = path.join(temp, "synthetic-project");
const token = randomBytes(24).toString("base64url");
let server;
let client;
let serverLogs = "";

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForReady(base, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Isolated server exited: " + serverLogs.slice(-1500));
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Isolated server health timeout: " + serverLogs.slice(-1500));
}

try {
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "example.ts"), "const CHECK = 1;\n", "utf8");
  await fs.writeFile(path.join(temp, "empty-upstream.json"), '{"version":1,"servers":[]}', "utf8");
  await fs.writeFile(path.join(temp, "empty.env"), "", "utf8");
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const base = "http://127.0.0.1:" + port;
  const childEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "CI"]) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }

  const serverOptions = {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...childEnv,
      DOTENV_CONFIG_PATH: path.join(temp, "empty.env"),
      HOST: "127.0.0.1",
      PORT: String(port),
      ADMIN_PORT: String(adminPort),
      MCP_TOKEN: token,
      WORKSPACE_PATH: project,
      CHATGPT_TOOL_PROFILE: "slim",
      MCP_SESSION_RECOVERY: "true",
      MCP_UPSTREAM_CONFIG: path.join(temp, "empty-upstream.json"),
      CHECKPOINT_PATH: path.join(temp, "checkpoints"),
      MCP_SHELL_STATE_DIR: path.join(temp, "shell-state"),
      AUDIT_LOG_PATH: path.join(temp, "audit.log"),
      POST_EDIT_HOOKS_CONFIG: path.join(temp, "missing-hooks.json"),
    },
  };
  const launchServer = () => {
    const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], serverOptions);
    child.stdout.on("data", (chunk) => (serverLogs += chunk.toString()));
    child.stderr.on("data", (chunk) => (serverLogs += chunk.toString()));
    return child;
  };
  server = launchServer();
  await waitForReady(base, server);

  const discovery = await fetch(base + "/mcp/" + token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 700, method: "server/discover", params: {} }),
  });
  assert.equal(discovery.status, 200, "unknown discovery method should get a JSON-RPC response");
  assert.equal(discovery.headers.get("mcp-session-id"), null, "discovery must not establish a session");
  assert.equal((await discovery.json()).error?.code, -32601, "unknown discovery method should not initialize the server");
  console.log("OK  discovery probe does not claim an initialized MCP session");

  client = new Client({ name: "chat-harness-http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/" + token)));
  const listed = await client.listTools();
  for (const name of ["inspect_code", "diagnose_failure", "edit_and_verify", "task_context"]) {
    assert.ok(listed.tools.some((tool) => tool.name === name), name + " missing from authenticated tools/list");
  }
  const editTool = listed.tools.find((tool) => tool.name === "edit_and_verify");
  assert.equal(editTool.annotations?.readOnlyHint, false);
  assert.ok(editTool.inputSchema?.properties?.command_mode?.enum?.includes("argv"),
    "explicit direct-argv mode must be advertised through tools/list");
  console.log("OK  authenticated Streamable HTTP tools/list exposes Chat-native harness");

  const before = await client.callTool({
    name: "inspect_code",
    arguments: { path: project, query: "CHECK", max_matches: 5 },
  });
  assert.equal(before.structuredContent?.ok, true);
  assert.equal(before.structuredContent?.data?.matches?.length, 1);
  console.log("OK  read-only inspection through actual HTTP MCP transport");

  const taskContext = await client.callTool({
    name: "task_context",
    arguments: { path: project, task: "Fix CHECK" },
  });
  assert.equal(taskContext.structuredContent?.ok, true);
  assert.ok(taskContext.structuredContent?.data?.files?.some((file) => file.path.endsWith("example.ts")));
  console.log("OK  task-aware context works through authenticated HTTP MCP");

  const ignoredDirectory = path.join(project, "ignored-fixture");
  await fs.mkdir(ignoredDirectory);
  await fs.writeFile(path.join(project, ".gitignore"), "ignored-fixture/\n", "utf8");
  await fs.writeFile(path.join(ignoredDirectory, "decoy.ts"), "const CHECK = 'IGNORED_MCP_DECOY';\n", "utf8");
  const safeGrep = await client.callTool({
    name: "grep",
    arguments: { path: project, pattern: "CHECK", output_mode: "files_with_matches" },
  });
  assert.equal(safeGrep.structuredContent?.ok, true);
  assert.ok(!safeGrep.structuredContent?.data?.output.includes("decoy.ts"), "default grep exposed ignored file");
  const legacyGrep = await client.callTool({
    name: "grep",
    arguments: { path: project, pattern: "CHECK", output_mode: "files_with_matches", respect_ignore: false },
  });
  assert.equal(legacyGrep.structuredContent?.ok, true);
  assert.ok(legacyGrep.structuredContent?.data?.output.includes("decoy.ts"), "explicit opt-out was ignored");
  console.log("OK  authenticated grep respects ignores unless explicitly opted out");

  const externalFixture = path.join(temp, "foreign-fixture");
  await fs.mkdir(externalFixture);
  await fs.writeFile(path.join(externalFixture, "outside.ts"), "UNTOUCHED=1\n", "utf8");
  const linkedFolder = path.join(project, "foreign-link");
  let linkCreated = false;
  try {
    await fs.symlink(externalFixture, linkedFolder, process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
  }
  if (linkCreated) {
    const unsafePatch = await client.callTool({
      name: "edit_and_verify",
      arguments: {
        path: path.join(linkedFolder, "outside.ts"), patch: "@@\n-UNTOUCHED=1\n+UNTOUCHED=2",
        command: "node --version", working_directory: project,
      },
    });
    assert.equal(unsafePatch.isError, true, "edit_and_verify must reject symlink directory aliases");
    assert.equal(await fs.readFile(path.join(externalFixture, "outside.ts"), "utf8"), "UNTOUCHED=1\n");
    console.log("OK  authenticated MCP rejects symlink redirects without altering outside files");
  }

  const contextPath = path.join(project, "AGENTS.md");
  await fs.writeFile(contextPath, "# One\nA", "utf8");
  const contextArgs = { path: project, max_depth: 0, max_bytes_per_file: 5 };
  const firstContext = await client.callTool({ name: "project_context", arguments: contextArgs });
  const revision = firstContext.structuredContent?.data?.revision;
  assert.match(revision, /^[a-f0-9]{64}$/);
  assert.equal(firstContext.structuredContent?.data?.files?.length, 1);
  assert.equal(firstContext.structuredContent?.data?.files?.[0]?.truncated, true);
  const cachedContext = await client.callTool({ name: "project_context", arguments: { ...contextArgs, if_revision: revision } });
  assert.equal(cachedContext.structuredContent?.data?.unchanged, true);
  assert.deepEqual(cachedContext.structuredContent?.data?.files, []);
  assert.equal(cachedContext.structuredContent?.data?.count, 1);
  const expandedContext = await client.callTool({
    name: "project_context",
    arguments: { ...contextArgs, max_bytes_per_file: 20, if_revision: revision },
  });
  assert.equal(expandedContext.structuredContent?.data?.unchanged, false);
  assert.notEqual(expandedContext.structuredContent?.data?.revision, revision);
  assert.equal(expandedContext.structuredContent?.data?.files?.[0]?.content, "# One\nA");
  await fs.writeFile(contextPath, "# Two\nA", "utf8");
  const newContext = await client.callTool({ name: "project_context", arguments: { ...contextArgs, if_revision: revision } });
  assert.equal(newContext.structuredContent?.data?.unchanged, false);
  assert.notEqual(newContext.structuredContent?.data?.revision, revision);
  const nextRevision = newContext.structuredContent?.data?.revision;
  await fs.writeFile(contextPath, "# Two\nB", "utf8");
  const tailChanged = await client.callTool({ name: "project_context", arguments: { ...contextArgs, if_revision: nextRevision } });
  assert.equal(tailChanged.structuredContent?.data?.unchanged, false);
  assert.notEqual(tailChanged.structuredContent?.data?.revision, nextRevision);
  assert.equal(tailChanged.structuredContent?.data?.files?.[0]?.content, newContext.structuredContent?.data?.files?.[0]?.content);
  const invalidContext = await client.callTool({ name: "project_context", arguments: { ...contextArgs, if_revision: "invalid" } });
  assert.equal(invalidContext.isError, true);
  console.log("OK  conditional project context invalidates on same-size and truncated-tail edits");

  const edited = await client.callTool({
    name: "edit_and_verify",
    arguments: {
      path: path.join(project, "example.ts"),
      patch: "@@\n-const CHECK = 1;\n+const CHECK = 2;",
      command: "node -e \"if(!require('fs').readFileSync('example.ts','utf8').includes('CHECK = 2'))process.exit(5)\"",
      working_directory: project,
    },
  });
  assert.equal(edited.structuredContent?.ok, true, JSON.stringify({
    summary: edited.structuredContent?.summary,
    verification: edited.structuredContent?.data?.verification,
    verification_error: edited.structuredContent?.data?.verification_error,
  }).slice(0, 1200));
  assert.equal(edited.structuredContent?.data?.verification?.exit_code, 0);
  assert.match(edited.structuredContent?.data?.patch?.checkpoint_id, /^cp_/);
  assert.match(await fs.readFile(path.join(project, "example.ts"), "utf8"), /CHECK = 2/);
  console.log("OK  edit, checkpoint and explicit verification through authenticated HTTP");

  const argvFile = path.join(project, "argv-example.ts");
  await fs.writeFile(argvFile, "const DIRECT = 1;\n");
  const argvEdit = await client.callTool({
    name: "edit_and_verify",
    arguments: {
      path: argvFile,
      patch: "@@\n-const DIRECT = 1;\n+const DIRECT = 2;",
      command: JSON.stringify([process.execPath, "-e",
        "if(!require('fs').readFileSync('argv-example.ts','utf8').includes('DIRECT = 2'))process.exit(7)"]),
      command_mode: "argv",
      working_directory: project,
    },
  });
  assert.equal(argvEdit.structuredContent?.ok, true, JSON.stringify(argvEdit.structuredContent).slice(0, 900));
  assert.equal(argvEdit.structuredContent?.data?.verification?.exit_code, 0);
  assert.match(argvEdit.structuredContent?.data?.patch?.checkpoint_id, /^cp_/);
  console.log("OK  explicit argv edit and checkpoint work over authenticated HTTP MCP");

  const manyPatch = [
    "*** Begin Patch",
    "*** Update File: example.ts",
    "@@",
    "-const CHECK = 2;",
    "+const CHECK = 3;",
    "*** Add File: extra.ts",
    "+export const EXTRA = 1;",
    "*** End Patch",
  ].join("\n");
  const safeDry = await client.callTool({ name: "apply_patch", arguments: { path: project, patch: manyPatch, safe: true, dry_run: true } });
  assert.equal(safeDry.structuredContent?.data?.safe, true);
  assert.equal(safeDry.structuredContent?.data?.files?.length, 2);
  assert.match(await fs.readFile(path.join(project, "example.ts"), "utf8"), /CHECK = 2/);
  const safeApplied = await client.callTool({ name: "apply_patch", arguments: { path: project, patch: manyPatch, safe: true } });
  assert.equal(safeApplied.structuredContent?.ok, true);
  assert.equal(safeApplied.structuredContent?.data?.safe, true);
  assert.match(safeApplied.structuredContent?.data?.checkpoint_id, /^cp_/);
  assert.match(await fs.readFile(path.join(project, "example.ts"), "utf8"), /CHECK = 3/);
  assert.equal(await fs.readFile(path.join(project, "extra.ts"), "utf8"), "export const EXTRA = 1;");
  console.log("OK  safe multi-file preview and commit through authenticated HTTP");

  const failure = await client.callTool({
    name: "diagnose_failure",
    arguments: { path: project, command: "node -e \"console.error('example.ts:1:1: failed');process.exit(4)\"" },
  });
  assert.equal(failure.structuredContent?.ok, false);
  assert.ok(failure.structuredContent?.data?.locations?.some((location) => location.path === "example.ts"));
  console.log("OK  failed command returned structured error locations over HTTP");

  for (let trial = 0; trial < 8; trial++) {
    const raceFile = path.join(project, "concurrent-" + trial + ".ts");
    await fs.writeFile(raceFile, "const RACE = 1;\n", "utf8");
    const change = (value) => client.callTool({
      name: "edit_and_verify",
      arguments: {
        path: raceFile,
        patch: "@@\n-const RACE = 1;\n+const RACE = " + value + ";",
        command: JSON.stringify([process.execPath, "--version"]),
        command_mode: "argv", working_directory: project,
      },
    });
    const [a, b] = await Promise.all([change(2), change(3)]);
    const winners = [a, b].filter((reply) => reply.structuredContent?.ok === true);
    assert.equal(winners.length, 1, "two competing patches must not both succeed");
    assert.match(await fs.readFile(raceFile, "utf8"), /^const RACE = [23];\n$/);
  }
  console.log("OK  concurrent edit-and-verify calls do not silently overwrite each other");

  const timeoutFile = path.join(project, "timeout-recovery.ts");
  await fs.writeFile(timeoutFile, "const RECOVER = 1;\n", "utf8");
  const timedEdit = await client.callTool({
    name: "edit_and_verify",
    arguments: {
      path: timeoutFile, patch: "@@\n-const RECOVER = 1;\n+const RECOVER = 2;",
      working_directory: project,
      command_mode: "argv", timeout_ms: 200,
      command: JSON.stringify([process.execPath, "-e", "setTimeout(() => process.exit(0), 5000)"]),
    },
  });
  assert.equal(timedEdit.structuredContent?.ok, false, "timed-out verification must not be successful");
  assert.equal(timedEdit.structuredContent?.data?.verification?.timed_out, true);
  const timeoutCheckpoint = timedEdit.structuredContent?.data?.patch?.checkpoint_id;
  assert.match(timeoutCheckpoint, /^cp_/);
  assert.equal(await fs.readFile(timeoutFile, "utf8"), "const RECOVER = 2;\n");
  const rewind = await client.callTool({
    name: "rewind", arguments: { action: "restore", checkpoint_id: timeoutCheckpoint },
  });
  assert.equal(rewind.structuredContent?.ok, true);
  assert.equal(await fs.readFile(timeoutFile, "utf8"), "const RECOVER = 1;\n");
  console.log("OK  timed-out verification leaves a rewindable checkpoint and restores original bytes");

  const unauthorized = await fetch(base + "/mcp", { method: "GET" });
  assert.notEqual(unauthorized.status, 200);
  console.log("OK  tokenless MCP endpoint does not expose tools");

  const restartFile = path.join(project, "post-restart.ts");
  await fs.writeFile(restartFile, "export const AFTER_RESTART = true;\n", "utf8");
  await client.close();
  client = null;
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  assert.ok(server.exitCode !== null || server.signalCode !== null, "isolated server did not stop");
  serverLogs = "";
  server = launchServer();
  await waitForReady(base, server);
  client = new Client({ name: "chat-harness-restart-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/" + token)));
  const resumed = await client.callTool({
    name: "inspect_code",
    arguments: { path: project, query: "AFTER_RESTART", max_matches: 2 },
  });
  assert.equal(resumed.structuredContent?.ok, true);
  assert.ok(resumed.structuredContent?.data?.matches?.some((entry) => entry.path === restartFile));
  assert.notEqual((await fetch(base + "/mcp", { method: "GET" })).status, 200);
  console.log("OK  fresh authenticated MCP session survives server restart and preserves synthetic files");

  if (process.argv.includes("--bench")) {
    const measurements = { separate: [], compound: [] };
    const bytes = { separate: [], compound: [] };
    const percentile = (numbers, p) => {
      const sorted = [...numbers].sort((a, b) => a - b);
      return sorted[Math.ceil(sorted.length * p) - 1].toFixed(1);
    };
    async function sample(kind, run) {
      const name = "bench-" + kind + "-" + run + ".ts";
      const file = path.join(project, name);
      await fs.writeFile(file, "const SPEED = 1;\n", "utf8");
      const patchText = "@@\n-const SPEED = 1;\n+const SPEED = 2;";
      const t0 = performance.now();
      let results;
      if (kind === "separate") {
        const changed = await client.callTool({
          name: "apply_patch",
          arguments: { path: file, patch: patchText },
        });
        assert.equal(changed.structuredContent?.ok, true);
        const checked = await client.callTool({
          name: "diagnose_failure",
          arguments: { path: project, command: "node --version" },
        });
        assert.equal(checked.structuredContent?.ok, true);
        results = [changed, checked];
      } else {
        const combined = await client.callTool({
          name: "edit_and_verify",
          arguments: {
            path: file,
            patch: patchText,
            command: "node --version",
            working_directory: project,
          },
        });
        assert.equal(combined.structuredContent?.ok, true);
        results = [combined];
      }
      const elapsed = performance.now() - t0;
      assert.match(await fs.readFile(file, "utf8"), /SPEED = 2/);
      if (run >= 2) {
        measurements[kind].push(elapsed);
        bytes[kind].push(Buffer.byteLength(JSON.stringify(results)));
      }
    }
    for (let i = 0; i < 14; i++) {
      const order = i % 2 === 0 ? ["separate", "compound"] : ["compound", "separate"];
      for (const kind of order) await sample(kind, i);
    }
    for (const kind of ["separate", "compound"]) {
      const timings = measurements[kind];
      const averageBytes = Math.round(bytes[kind].reduce((a, b) => a + b, 0) / bytes[kind].length);
      console.log(
        "BENCH " + kind +
        ": calls=" + (kind === "separate" ? 2 : 1) +
        " p50=" + percentile(timings, 0.5) + "ms" +
        " p95=" + percentile(timings, 0.95) + "ms" +
        " response=" + averageBytes + "B" +
        " samples=" + timings.length,
      );
    }
    await fs.writeFile(path.join(project, "README.md"), "Synthetic project context\n".repeat(1400), "utf8");
    const contextFull = await client.callTool({ name: "project_context", arguments: { path: project, max_depth: 0 } });
    const contextSkipped = await client.callTool({
      name: "project_context",
      arguments: { path: project, max_depth: 0, if_revision: contextFull.structuredContent?.data?.revision },
    });
    assert.equal(contextSkipped.structuredContent?.data?.unchanged, true);
    const contextFullBytes = Buffer.byteLength(JSON.stringify(contextFull));
    const contextSkippedBytes = Buffer.byteLength(JSON.stringify(contextSkipped));
    console.log("BENCH context full=" + contextFullBytes + "B unchanged=" + contextSkippedBytes + "B");
    console.log("BENCH scope: warm local authenticated HTTP session, not ChatGPT UI/model latency");
  }

  console.log("\nHTTP integration checks including ignore safety, concurrency and restart passed");
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