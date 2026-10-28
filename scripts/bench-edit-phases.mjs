import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

// Direct local phase timings: never executes a model, API, tunnel, Work or user project.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-edit-phases-"));
process.env.CHECKPOINT_ENABLED = "true";
process.env.CHECKPOINT_PATH = path.join(root, "checkpoints");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.MCP_SHELL_STATE_DIR = path.join(root, "shells");
process.env.POST_EDIT_HOOKS_CONFIG = path.join(root, "no-hooks.json");

const { applySingleFilePatch } = await import("../dist/lib/single-file-patch.js");
const { diagnoseFailure, editAndVerify } = await import("../dist/lib/harness-operations.js");
const exec = promisify(execFile);
const command = `node -e "process.exit(0)"`;
const argvCommand = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
const patch = "@@\n-const VALUE = 1;\n+const VALUE = 2;";
const timings = { patch: [], verify_shell: [], verify_direct_node: [], verify_argv_harness: [], combined: [], combined_argv: [] };

async function measured(kind, run) {
  const started = performance.now();
  await run();
  timings[kind].push(performance.now() - started);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(1));
}

try {
  for (let i = 0; i < 10; i++) {
    const file = path.join(root, `patch-${i}.ts`);
    const combined = path.join(root, `combined-${i}.ts`);
    const directCombined = path.join(root, `combined-argv-${i}.ts`);
    await fs.writeFile(file, "const VALUE = 1;\n");
    await fs.writeFile(combined, "const VALUE = 1;\n");
    await fs.writeFile(directCombined, "const VALUE = 1;\n");
    await measured("patch", async () => {
      const result = await applySingleFilePatch({ path: file, patch, checkpointTool: "edit_and_verify" });
      assert.ok(result.checkpoint_id, "complete checkpoint must be present");
    });
    await measured("verify_shell", async () => {
      const result = await diagnoseFailure({ root, command, timeoutMs: 10_000 });
      assert.equal(result.exit_code, 0);
    });
    await measured("verify_direct_node", async () => {
      await exec(process.execPath, ["-e", "process.exit(0)"], { cwd: root, windowsHide: true });
    });
    await measured("verify_argv_harness", async () => {
      const result = await diagnoseFailure({ root, command: argvCommand, commandMode: "argv", timeoutMs: 10_000 });
      assert.equal(result.exit_code, 0);
    });
    await measured("combined", async () => {
      const result = await editAndVerify({ path: combined, patch, command, workingDirectory: root, timeoutMs: 10_000 });
      assert.equal(result.ok, true);
      assert.ok(result.patch.checkpoint_id);
    });
    await measured("combined_argv", async () => {
      const result = await editAndVerify({
        path: directCombined, patch, command: argvCommand, commandMode: "argv",
        workingDirectory: root, timeoutMs: 10_000,
      });
      assert.equal(result.ok, true);
      assert.ok(result.patch.checkpoint_id);
    });
  }
  const summary = Object.fromEntries(Object.entries(timings).map(([kind, values]) => [kind, {
    samples: values.length - 2,
    p50_ms: percentile(values.slice(2), 0.5),
    p95_ms: percentile(values.slice(2), 0.95),
  }]));
  console.log("BENCH edit phases", JSON.stringify(summary));
  console.log("BENCH scope: direct local QA functions on disposable files only; no API/model/Work.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}