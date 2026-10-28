import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildTaskContext } from "../dist/lib/task-context.js";

// Fixed, hand-labeled synthetic code owners. No models, internet or user data.
const cases = [
  { file: "src/auth/session-refresh.ts", task: "Refreshing session cookies", code: "export function refreshSessionCookie() { return true; }" },
  { file: "src/payments/refund-ledger.ts", task: "Preventing duplicate refund transactions", code: "export function preventDuplicateRefundTransaction() { return true; }" },
  { file: "src/ui/form-errors.ts", task: "Rendering form errors", code: "export function renderFormError() { return true; }" },
  { file: "src/jobs/backoff.ts", task: "Retrying failed jobs with backoff", code: "export function retryFailedJobWithBackoff() { return true; }" },
  { file: "app/billing/invoice_parser.py", task: "Parsing invoice CSV records", code: "def parse_invoice_csv_record():\n    return None" },
  { file: "app/security/token_store.py", task: "Storing access tokens", code: "def store_access_token():\n    return None" },
  { file: "app/reports/monthly_summary.py", task: "Building monthly reports", code: "def build_monthly_report():\n    return None" },
  { file: "app/images/thumbnail_resize.py", task: "Resizing image thumbnails", code: "def resize_image_thumbnail():\n    return None" },
  { file: "internal/cache/eviction.go", task: "Evicting stale cache entries", code: "package cache\nfunc EvictStaleCacheEntry() {}" },
  { file: "internal/http/request_validation.go", task: "Validating HTTP requests", code: "package http\nfunc ValidateHTTPRequest() {}" },
  { file: "pkg/sync/delta_merge.go", task: "Merging remote deltas", code: "package sync\nfunc MergeRemoteDelta() {}" },
  { file: "pkg/queue/lease_renew.go", task: "Renewing worker leases", code: "package queue\nfunc RenewWorkerLease() {}" },
];

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-multilang-bench-"));
const ranks = [];
const elapsedMs = [];
try {
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  for (const { file, task, code } of cases) {
    const source = path.join(root, file);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, code + "\n");
    const stem = path.basename(file, path.extname(file));
    await fs.writeFile(path.join(root, "scripts", `bench-${stem}.mjs`),
      `// Incidental task text, not an implementation\nconst task = ${JSON.stringify(task)};\n`);
    await fs.writeFile(path.join(root, "tests", `${stem}.test.ts`),
      `// Regression test for ${stem}\n`);
  }
  for (const { file, task } of cases) {
    const started = performance.now();
    const result = await buildTaskContext({ root, task });
    elapsedMs.push(performance.now() - started);
    const rank = result.files.findIndex((entry) => path.relative(root, entry.path).replaceAll("\\", "/") === file) + 1;
    ranks.push(rank);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 9000, "output bound violated");
    console.log("CASE", JSON.stringify({ file, task, rank: rank || null,
      top: result.files.slice(0, 3).map((entry) => path.relative(root, entry.path).replaceAll("\\", "/")) }));
  }
  const hits = (k) => ranks.filter((rank) => rank > 0 && rank <= k).length;
  const sorted = elapsedMs.sort((a, b) => a - b);
  const percentile = (fraction) => Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(1));
  console.log("BENCH multilang", JSON.stringify({ evaluated: cases.length,
    hits_at_1: hits(1), hits_at_3: hits(3), hits_at_6: hits(6),
    mrr: Number((ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / cases.length).toFixed(3)),
    p50_ms: percentile(0.5), p95_ms: percentile(0.95) }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}