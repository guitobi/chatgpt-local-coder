import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildTaskContext } from "../dist/lib/task-context.js";

// A fresh process measures retrieval without retaining fixture-creation memory.
const [root, countText] = process.argv.slice(2);
const count = Number(countText);
assert.ok(path.isAbsolute(root) && Number.isInteger(count) && count > 0 && count <= 10000);
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())), "only disposable benchmark roots allowed");

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(1));
}

const probes = [
  { task: "earlyAnchorToken", expected: "a-owner.ts" },
  { task: "lateUniqueOwnerToken", expected: "z-owner.ts" },
  { task: "ignoredSensitiveOwnerToken", expected: null },
];
const runs = [];
for (let cycle = 0; cycle < 3; cycle++) {
  for (const { task, expected } of probes) {
    const started = performance.now();
    const result = await buildTaskContext({ root, task });
    const elapsed = performance.now() - started;
    const found = result.files.some((file) => path.basename(file.path) === expected);
    assert.ok(result.files.every((file) => path.relative(root, file.path).split(path.sep)[0] !== ".."), "escaped disposable root");
    if (expected === null) assert.equal(result.files.length, 0, "ignored source exposed");
    else assert.ok(found, `missing ${expected} in ${count}-file fixture`);
    const memory = process.memoryUsage();
    runs.push({ task, expected, found, elapsed_ms: Number(elapsed.toFixed(1)),
      searched_files: result.searched_files, truncated: result.truncated,
      warnings: result.warnings, rss_mb: Number((memory.rss / 1048576).toFixed(1)),
      heap_used_mb: Number((memory.heapUsed / 1048576).toFixed(1)) });
  }
}
const warm = runs.slice(3).map((item) => item.elapsed_ms);
const multiRuns = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const result = await buildTaskContext({ root,
    task: "lateUniqueOwnerToken absentTokenOne absentTokenTwo absentTokenThree" });
  assert.ok(result.files.some((file) => path.basename(file.path) === "z-owner.ts"),
    "rare multi-term search lost the late source");
  multiRuns.push(Number((performance.now() - started).toFixed(1)));
}
const clusteredRuns = [];
const clusteredLateOwnerFound = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const result = await buildTaskContext({ root,
    task: "clusteredBurstToken lateUniqueOwnerToken absentTokenOne absentTokenTwo" });
  clusteredLateOwnerFound.push(result.files.some((file) => path.basename(file.path) === "z-owner.ts"));
  clusteredRuns.push(Number((performance.now() - started).toFixed(1)));
}
const finalMemory = process.memoryUsage();
global.gc?.();
const afterGcMemory = process.memoryUsage();
console.log(JSON.stringify({
  count, warm_p50_ms: percentile(warm, 0.5), warm_p95_ms: percentile(warm, 0.95),
  max_retrieval_rss_mb: Math.max(...runs.map((item) => item.rss_mb)),
  max_sampled_heap_used_mb: Math.max(...runs.map((item) => item.heap_used_mb)),
  final_heap_used_mb: Number((finalMemory.heapUsed / 1048576).toFixed(1)),
  post_gc_heap_used_mb: Number((afterGcMemory.heapUsed / 1048576).toFixed(1)),
  post_gc_rss_mb: Number((afterGcMemory.rss / 1048576).toFixed(1)),
  multi_term_p50_ms: percentile(multiRuns, 0.5),
  multi_term_samples_ms: multiRuns,
  clustered_p50_ms: percentile(clusteredRuns, 0.5),
  clustered_samples_ms: clusteredRuns,
  clustered_late_owner_found: clusteredLateOwnerFound,
  probes: runs.slice(0, 3),
  repeated: runs.slice(3).map(({ task, found, elapsed_ms }) => ({ task, found, elapsed_ms })),
}));