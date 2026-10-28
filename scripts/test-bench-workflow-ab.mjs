import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { stdout } = await execFileAsync(
  process.execPath,
  [path.join(root, "scripts", "bench-local-ab.mjs"), "--workflow-only"],
  { cwd: root, timeout: 150_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
);
const records = stdout.split(/\r?\n/).filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));

for (const version of ["main", "qa"]) {
  const row = records.find((record) => record.scenario === "full_workflow" && record.version === version);
  assert.ok(row, `${version} must report a full-workflow result`);
  assert.equal(row.samples, 3, `${version} must report 3 measured smoke samples`);
  assert.equal(row.calls_per_sample, version === "main" ? 5 : 4);
  assert.equal(row.failed_test_observed, 3, `${version} must first witness the failing test`);
  assert.equal(row.correct_source, 3, `${version} must use a real search result to choose the owner`);
  assert.equal(row.verification_passed, 3, `${version} must verify a passing test after the patch`);
  assert.ok(row.p50_ms > 0 && row.p95_ms >= row.p50_ms, `${version} timing must be measured`);
  assert.ok(row.avg_response_bytes > 0, `${version} response size must be measured`);
  console.log(`OK  ${version} full scripted workflow: fail → search → read → fix → passing test`);
}

assert.match(stdout, /no model\/API\/Work/i, "benchmark must label its offline-only scope");

const { stdout: metricsStdout } = await execFileAsync(
  process.execPath,
  [path.join(root, "scripts", "bench-local-ab.mjs"), "--workflow-only", "--qa-metrics-on"],
  { cwd: root, timeout: 150_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
);
const metricsRecords = metricsStdout.split(/\r?\n/).filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
const metricsRow = metricsRecords.find((record) => record.scenario === "telemetry" && record.version === "qa");
assert.equal(metricsRow?.enabled, true, "QA telemetry must be opt-in and active when requested");
assert.ok(metricsRow.tools_measured > 0, "QA metrics must observe MCP tool callbacks");
assert.ok(metricsRow.observed_calls >= 12, "QA must measure all scripted workflow operations");
assert.ok(metricsRow.read_text_file_calls >= 4, "QA must record read_text_file tool calls");
assert.equal(metricsRow.errors, 4, "QA must count each expected failing test without leaking data");
assert.doesNotMatch(metricsStdout, /PRIVATE_METRICS_FIXTURE_NEVER_LOG|synthetic-local-admin-token/);
assert.match(metricsStdout, /no model\/API\/Work/i, "metrics-on benchmark must remain offline");
console.log("QA opt-in telemetry: aggregate counts, errors, privacy, offline scope passed");
console.log("2 full-workflow scenarios passed, 0 failed");