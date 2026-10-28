import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Measures MCP operations only. No model, OpenAI API, tunnel, or Work calls.
const qaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = path.resolve(qaRoot, "..", "chatgpt-local-coder");
const workflowOnly = process.argv.includes("--workflow-only");
const qaMetricsOn = process.argv.includes("--qa-metrics-on");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-local-ab-"));
const runtimes = {};
const samples = { main: { read: [], edit: [], edit_argv: [], grep: [], full_workflow: [] }, qa: { read: [], edit: [], edit_argv: [], grep: [], task_context: [], full_workflow: [] } };
const responses = { main: { read: [], edit: [], edit_argv: [], grep: [], full_workflow: [] }, qa: { read: [], edit: [], edit_argv: [], grep: [], task_context: [], full_workflow: [] } };
const searchDecoys = { main: null, qa: null };
const workflowEvidence = {
  main: { failed_test_observed: 0, correct_source: 0, verification_passed: 0 },
  qa: { failed_test_observed: 0, correct_source: 0, verification_passed: 0 },
};
const sampleCount = workflowOnly ? 4 : 14;
const warmups = workflowOnly ? 1 : 2;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
}

async function launch(name, root) {
  const dir = path.join(temp, name);
  const project = path.join(dir, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "AGENTS.md"), "# Local benchmark\n".repeat(1200));
  await fs.writeFile(path.join(project, "source.ts"), "export const STATUS = 1;\n");
  const token = randomBytes(20).toString("base64url");
  const listen = await port();
  let admin = await port();
  while (admin === listen) admin = await port();
  const adminToken = name === "qa" && qaMetricsOn ? randomBytes(20).toString("base64url") : null;
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  assert.ok(!Object.keys(env).some((key) => /API_KEY|TOKEN|SECRET/i.test(key)), "No credentials may enter the child environment");
  Object.assign(env, {
    DOTENV_CONFIG_PATH: path.join(temp, "empty.env"),
    HOST: "127.0.0.1",
    PORT: String(listen),
    ADMIN_PORT: String(admin),
    MCP_TOKEN: token,
    WORKSPACE_PATH: project,
    CHATGPT_TOOL_PROFILE: name === "qa" ? "focused" : "slim",
    MCP_SESSION_RECOVERY: "false",
    MCP_UPSTREAM_CONFIG: path.join(temp, "upstreams.json"),
    CHECKPOINT_PATH: path.join(dir, "checkpoints"),
    MCP_SHELL_STATE_DIR: path.join(dir, "shells"),
    AUDIT_LOG_PATH: path.join(dir, "audit.log"),
    POST_EDIT_HOOKS_CONFIG: path.join(dir, "hooks.json"),
    SHELL_TIMEOUT: "15",
    LOCAL_CODER_METRICS: name === "qa" && qaMetricsOn ? "1" : "0",
  });
  if (adminToken) env.ADMIN_TOKEN = adminToken;

  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime = {
    name, root, dir, project, child, logs: "", client: null,
    adminBase: `http://127.0.0.1:${admin}`, adminToken,
  };
  runtimes[name] = runtime;
  for (const output of [child.stdout, child.stderr]) {
    output.on("data", (chunk) => {
      runtime.logs = (runtime.logs + chunk.toString()).slice(-4000);
    });
  }

  const base = `http://127.0.0.1:${listen}`;
  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(700) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, `${name} failed to start: ${runtime.logs.slice(-1200)}`);

  runtime.client = new Client({ name: "free-local-ab", version: "1" });
  await runtime.client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
  runtime.tools = await runtime.client.listTools();
  console.log(`READY ${name}: tools=${runtime.tools.tools.length} catalog_bytes=${Buffer.byteLength(JSON.stringify(runtime.tools))}`);
}

async function call(runtime, name, args) {
  const result = await runtime.client.callTool({ name, arguments: args });
  assert.equal(result.structuredContent?.ok, true, `${runtime.name}/${name}: ${JSON.stringify(result.structuredContent).slice(0, 600)}`);
  return result;
}

async function sampleRead(name, run) {
  const runtime = runtimes[name];
  const started = performance.now();
  const result = await call(runtime, "read_text_file", { path: path.join(runtime.project, "source.ts") });
  const elapsed = performance.now() - started;
  assert.match(JSON.stringify(result.structuredContent), /STATUS = 1/);
  if (run >= warmups) {
    samples[name].read.push(elapsed);
    responses[name].read.push(Buffer.byteLength(JSON.stringify(result)));
  }
}

async function sampleEdit(name, run, mode = "shell") {
  const runtime = runtimes[name];
  const scenario = mode === "argv" ? "edit_argv" : "edit";
  const file = path.join(runtime.project, `${scenario}-${run}.ts`);
  await fs.writeFile(file, "const SPEED = 1;\n");
  const patch = "@@\n-const SPEED = 1;\n+const SPEED = 2;";
  const check = "if(!require('fs').readFileSync('" + path.basename(file) + "','utf8').includes('SPEED = 2'))process.exit(8)";
  const command = "node -e \"" + check + "\"";
  const started = performance.now();
  const results = name === "qa"
    ? [await call(runtime, "edit_and_verify", {
        path: file, patch,
        command: mode === "argv" ? JSON.stringify([process.execPath, "-e", check]) : command,
        command_mode: mode,
        working_directory: runtime.project,
      })]
    : [
        await call(runtime, "apply_patch", { path: file, patch }),
        await call(runtime, "run_command", { command, working_directory: runtime.project }),
      ];
  const elapsed = performance.now() - started;
  assert.match(await fs.readFile(file, "utf8"), /SPEED = 2/);
  if (run >= warmups) {
    samples[name][scenario].push(elapsed);
    responses[name][scenario].push(Buffer.byteLength(JSON.stringify(results)));
  }
}

async function populateSearchFixture(runtime) {
  const src = path.join(runtime.project, "src");
  const tests = path.join(runtime.project, "tests");
  const ignored = path.join(runtime.project, "ignored");
  await Promise.all([src, tests, ignored].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(runtime.project, ".gitignore"), "ignored/\n");
  for (let first = 0; first < 600; first += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, offset) => {
      const n = first + offset;
      return fs.writeFile(path.join(src, `module-${n}.ts`), `export const stableModule${n} = ${n};\n`);
    }));
  }
  await fs.writeFile(path.join(src, "owner.ts"), "export function calculateForecastNet(hours: number, rate: number) { return hours * rate; }\n");
  await fs.writeFile(path.join(tests, "owner.test.ts"), "import { calculateForecastNet } from '../src/owner';\nvoid calculateForecastNet(4, 5);\n");
  await fs.writeFile(path.join(ignored, "fake.ts"), "export const calculateForecastNet = 'ignored decoy';\n");
}

async function sampleSearch(name, run) {
  const runtime = runtimes[name];
  const started = performance.now();
  const result = await call(runtime, "grep", {
    pattern: "calculateForecastNet", path: runtime.project,
    output_mode: "files_with_matches", head_limit: 10,
  });
  const elapsed = performance.now() - started;
  const output = JSON.stringify(result.structuredContent?.data);
  assert.match(output, /owner\.ts/, `${name} grep must locate the symbol owner`);
  searchDecoys[name] = /fake\.ts/.test(output);
  if (run >= warmups) {
    samples[name].grep.push(elapsed);
    responses[name].grep.push(Buffer.byteLength(JSON.stringify(result)));
  }
}

async function sampleTaskContext(run) {
  const runtime = runtimes.qa;
  const started = performance.now();
  const result = await call(runtime, "task_context", {
    task: "calculateForecastNet", path: runtime.project,
    max_files: 6, max_chars: 9000,
  });
  const elapsed = performance.now() - started;
  const data = result.structuredContent?.data;
  const ownerRank = data.files.findIndex((file) => file.path.endsWith("owner.ts")) + 1;
  assert.ok(ownerRank >= 1 && ownerRank <= 3, `QA task_context owner rank must be <=3, found ${ownerRank}`);
  assert.ok(data.files[ownerRank - 1].lines.some((line) => line.text.includes("calculateForecastNet")));
  assert.ok(data.files.every((file) => !file.path.endsWith("fake.ts")), "QA must respect .gitignore");
  if (run >= warmups) {
    samples.qa.task_context.push(elapsed);
    responses.qa.task_context.push(Buffer.byteLength(JSON.stringify(result)));
  }
  return { owner_rank: ownerRank, searched_files: data.searched_files, warnings: data.warnings.length };
}

async function prepareWorkflowFixture(runtime) {
  await fs.writeFile(
    path.join(runtime.project, "tests", "invoice.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "import { calculateInvoiceNet } from '../src/invoice.mjs';\n" +
      "test('net amount excludes the accidental extra unit', () => { assert.equal(calculateInvoiceNet(4, 5), 20); });\n",
  );
}

async function sampleWorkflow(name, run) {
  const runtime = runtimes[name];
  const file = path.join(runtime.project, "src", "invoice.mjs");
  const broken = "export function calculateInvoiceNet(hours, rate) { return hours * rate + 1; }\n";
  const fixed = "export function calculateInvoiceNet(hours, rate) { return hours * rate; }\n";
  await fs.writeFile(file, broken);
  const command = "node --test tests/invoice.test.mjs";
  const argv = JSON.stringify([process.execPath, "--test", "tests/invoice.test.mjs"]);
  let calls = 0;
  let totalBytes = 0;
  const invoke = async (tool, args, expectFailure = false) => {
    const result = await runtime.client.callTool({ name: tool, arguments: args });
    calls += 1;
    totalBytes += Buffer.byteLength(JSON.stringify(result));
    const data = result.structuredContent?.data;
    if (expectFailure) {
      assert.equal(result.structuredContent?.ok, false, `${name}: the initial test must fail`);
      assert.equal(data?.exit_code, 1, `${name}: expected a real failing Node test`);
    } else {
      assert.equal(result.structuredContent?.ok, true, `${name}/${tool}: ${JSON.stringify(result.structuredContent).slice(0, 550)}`);
    }
    return result;
  };

  const started = performance.now();
  await invoke(
    name === "qa" ? "diagnose_failure" : "run_command",
    name === "qa"
      ? { command: argv, command_mode: "argv", path: runtime.project }
      : { command, working_directory: runtime.project },
    true,
  );
  if (run >= warmups) workflowEvidence[name].failed_test_observed++;

  let selected;
  if (name === "qa") {
    const result = await invoke("task_context", { task: "calculateInvoiceNet", path: runtime.project, max_files: 6, max_chars: 9000 });
    selected = result.structuredContent.data.files.find((entry) =>
      entry.lines.some((line) => line.text.includes("export function calculateInvoiceNet")))?.path;
  } else {
    const result = await invoke("grep", {
      pattern: "calculateInvoiceNet", path: runtime.project,
      output_mode: "files_with_matches", head_limit: 20,
    });
    selected = result.structuredContent.data.output.split(/\r?\n/).find((entry) =>
      entry.toLowerCase().endsWith(".mjs") && !entry.toLowerCase().endsWith(".test.mjs"));
  }
  assert.ok(selected, `${name}: search did not return an implementation file`);
  assert.equal(path.resolve(selected), path.resolve(file), `${name}: search chose the wrong owner`);
  if (run >= warmups) workflowEvidence[name].correct_source++;

  const read = await invoke("read_text_file", { path: selected });
  assert.match(JSON.stringify(read.structuredContent?.data), /return hours \* rate \+ 1/, `${name}: must inspect the broken line before editing`);
  const patch = "@@\n-" + broken.trimEnd() + "\n+" + fixed.trimEnd();
  if (name === "qa") {
    const result = await invoke("edit_and_verify", {
      path: selected, patch, command: argv, command_mode: "argv",
      working_directory: runtime.project,
    });
    assert.equal(result.structuredContent.data.verification?.exit_code, 0, "QA verification must pass");
  } else {
    await invoke("apply_patch", { path: selected, patch });
    const result = await invoke("run_command", { command, working_directory: runtime.project });
    assert.equal(result.structuredContent.data.exit_code, 0, "Main verification must pass");
  }
  assert.equal(await fs.readFile(file, "utf8"), fixed, `${name}: only the intended repair must remain`);
  assert.equal(calls, name === "main" ? 5 : 4, `${name}: unexpected MCP call count`);
  if (run >= warmups) {
    workflowEvidence[name].verification_passed++;
    samples[name].full_workflow.push(performance.now() - started);
    responses[name].full_workflow.push(totalBytes);
  }
}

function reportWorkflow() {
  for (const name of ["main", "qa"]) {
    const times = samples[name].full_workflow;
    const bytes = responses[name].full_workflow;
    console.log(JSON.stringify({
      version: name, scenario: "full_workflow", samples: times.length,
      calls_per_sample: name === "main" ? 5 : 4,
      ...workflowEvidence[name],
      p50_ms: percentile(times, 0.5),
      p95_ms: percentile(times, 0.95),
      avg_response_bytes: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length),
    }));
  }
}

async function reportQaMetrics() {
  const runtime = runtimes.qa;
  const response = await fetch(runtime.adminBase + "/api/tool-metrics", {
    headers: { Authorization: `Bearer ${runtime.adminToken}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, "QA admin must expose metrics with its ephemeral token");
  const snapshot = await response.json();
  assert.equal(snapshot.enabled, true, "Opt-in metrics must be enabled only in QA child");
  assert.ok(Array.isArray(snapshot.tools));
  const expectedNames = ["diagnose_failure", "edit_and_verify", "read_text_file", "task_context"];
  if (!workflowOnly) expectedNames.push("grep", "project_context");
  assert.deepEqual(
    snapshot.tools.map((row) => row.name).sort(),
    expectedNames.sort(),
    "QA telemetry must record the actual benchmark tool types",
  );
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /calculateInvoiceNet|invoice\.mjs|Bearer|PRIVATE_METRICS_FIXTURE_NEVER_LOG/);
  assert.ok(!serialized.includes(runtime.project), "Telemetry must not expose the project path");
  assert.ok(!serialized.includes(runtime.adminToken), "Telemetry must not expose the admin token");
  console.log(JSON.stringify({
    version: "qa", scenario: "telemetry", enabled: true,
    tools_measured: snapshot.tools.length,
    observed_calls: snapshot.tools.reduce((total, row) => total + row.calls, 0),
    read_text_file_calls: snapshot.tools.find((row) => row.name === "read_text_file")?.calls ?? 0,
    errors: snapshot.tools.reduce((total, row) => total + row.errors, 0),
  }));
}

function report(kind) {
  for (const name of (kind === "task_context" ? ["qa"] : ["main", "qa"])) {
    const times = samples[name][kind];
    const bytes = responses[name][kind];
    const calls = kind.startsWith("edit") && name === "main" ? 2 : 1;
    if (kind === "edit_argv" && name === "main") {
      assert.equal(calls, 2, "legacy edit+verify still requires two MCP calls in the argv comparison");
    }
    console.log(JSON.stringify({
      version: name,
      scenario: kind,
      calls,
      verification_mode: !kind.startsWith("edit") ? "none" : kind === "edit_argv" && name === "qa" ? "argv" : "shell",
      samples: times.length,
      p50_ms: percentile(times, 0.5),
      p95_ms: percentile(times, 0.95),
      avg_response_bytes: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length),
    }));
  }
}

try {
  assert.notEqual(mainRoot, qaRoot);
  await fs.access(path.join(mainRoot, "dist", "index.js"));
  await fs.access(path.join(qaRoot, "dist", "index.js"));
  await fs.writeFile(path.join(temp, "empty.env"), "");
  await fs.writeFile(path.join(temp, "upstreams.json"), '{"version":1,"servers":[]}');
  await launch("main", mainRoot);
  await launch("qa", qaRoot);
  if (!workflowOnly) {
    for (let i = 0; i < sampleCount; i++) {
      const order = i % 2 === 0 ? ["main", "qa"] : ["qa", "main"];
      for (const name of order) await sampleRead(name, i);
      for (const mode of (i % 2 === 0 ? ["shell", "argv"] : ["argv", "shell"])) {
        for (const name of order) await sampleEdit(name, i, mode);
      }
    }
    report("read");
    report("edit");
    report("edit_argv");
    console.log("SCENARIO edit_argv: main uses its legacy shell command; QA uses the explicit argv execution mode.");
    for (const name of ["main", "qa"]) {
      const runtime = runtimes[name];
      const full = await call(runtime, "project_context", { path: runtime.project, max_depth: 0 });
      const next = await call(runtime, "project_context", name === "qa"
        ? { path: runtime.project, max_depth: 0, if_revision: full.structuredContent?.data?.revision }
        : { path: runtime.project, max_depth: 0 });
      console.log(JSON.stringify({ version: name, scenario: "repeat_context", full_bytes: Buffer.byteLength(JSON.stringify(full)), repeat_bytes: Buffer.byteLength(JSON.stringify(next)), unchanged: next.structuredContent?.data?.unchanged === true }));
    }
  }
  await Promise.all(Object.values(runtimes).map(populateSearchFixture));
  if (!workflowOnly) {
    let lastContext;
    for (let i = 0; i < sampleCount; i++) {
      const order = i % 2 === 0 ? ["main", "qa"] : ["qa", "main"];
      for (const name of order) await sampleSearch(name, i);
      lastContext = await sampleTaskContext(i);
    }
    report("grep");
    for (const name of ["main", "qa"]) {
      console.log(JSON.stringify({ version: name, scenario: "grep_ignore_behavior", ignored_file_included: searchDecoys[name] }));
    }
    report("task_context");
    console.log(JSON.stringify({ version: "qa", scenario: "task_context_relevance", ...lastContext, main_equivalent: false }));
  }
  await Promise.all(Object.values(runtimes).map(prepareWorkflowFixture));
  for (let i = 0; i < sampleCount; i++) {
    const order = i % 2 === 0 ? ["main", "qa"] : ["qa", "main"];
    for (const name of order) await sampleWorkflow(name, i);
  }
  reportWorkflow();
  if (qaMetricsOn) await reportQaMetrics();
  console.log("SCOPE: local MCP client and server only; no model/API/Work; each version uses disposable project data.");
} finally {
  for (const runtime of Object.values(runtimes)) {
    await runtime.client?.close().catch(() => {});
    if (runtime.child && runtime.child.exitCode === null) {
      runtime.child.kill();
      await Promise.race([
        new Promise((resolve) => runtime.child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
}