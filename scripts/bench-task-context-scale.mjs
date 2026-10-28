import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Entirely synthetic disposable trees; no model, API, tunnel or user repository edits.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-scale-"));
const summary = [];
const run = promisify(execFile);

async function makeRepo(count) {
  const root = path.join(scratch, `repo-${count}`);
  const source = path.join(root, "src");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "src/ignored-owner.ts\n");
  await fs.writeFile(path.join(source, "a-owner.ts"), "export const earlyAnchorToken = true;\n");
  await fs.writeFile(path.join(source, "z-owner.ts"), "export const lateUniqueOwnerToken = true;\n");
  await fs.writeFile(path.join(source, "ignored-owner.ts"), "export const ignoredSensitiveOwnerToken = true;\n");
  const batch = 96;
  for (let start = 0; start < count; start += batch) {
    const end = Math.min(start + batch, count);
    await Promise.all(Array.from({ length: end - start }, (_, i) =>
      fs.writeFile(path.join(source, `middle-${String(start + i).padStart(6, "0")}.ts`),
        "export const genericValue = 1;\n" +
          (start + i >= 100 && start + i < 240 ? "export const clusteredBurstToken = 1;\n" : ""))));
  }
  return root;
}

try {
  const counts = process.env.LOCAL_CODER_SCALE_COUNTS
    ? process.env.LOCAL_CODER_SCALE_COUNTS.split(",").map(Number)
    : [1000, 10000];
  assert.ok(counts.length > 0 && counts.every((value) => Number.isInteger(value) && value > 0 && value <= 10000));
  for (const count of counts) {
    const root = await makeRepo(count);
    const { stdout } = await run(process.execPath,
      ["--expose-gc", fileURLToPath(new URL("./bench-task-context-scale-worker.mjs", import.meta.url)), root, String(count)],
      { windowsHide: true, timeout: 180000, maxBuffer: 128 * 1024, encoding: "utf8" });
    summary.push(JSON.parse(stdout.trim()));
    console.log("BENCH scale", JSON.stringify(summary.at(-1)));
    if (process.env.LOCAL_CODER_SCALE_PROFILE === "1") {
      const { stdout: profile } = await run(process.execPath,
        [fileURLToPath(new URL("./bench-task-context-search-modes.mjs", import.meta.url)), root],
        { windowsHide: true, timeout: 180000, maxBuffer: 128 * 1024, encoding: "utf8" });
      process.stdout.write(profile);
    }
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}