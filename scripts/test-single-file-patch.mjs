import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-single-patch-"));
const original = {
  CHECKPOINT_PATH: process.env.CHECKPOINT_PATH,
  CHECKPOINT_ENABLED: process.env.CHECKPOINT_ENABLED,
  POST_EDIT_HOOKS_CONFIG: process.env.POST_EDIT_HOOKS_CONFIG,
  AUDIT_LOG_PATH: process.env.AUDIT_LOG_PATH,
};

try {
  process.env.CHECKPOINT_PATH = path.join(dir, "checkpoints");
  process.env.CHECKPOINT_ENABLED = "true";
  process.env.POST_EDIT_HOOKS_CONFIG = path.join(dir, "absent-hooks.json");
  process.env.AUDIT_LOG_PATH = path.join(dir, "audit.log");
  const { applySingleFilePatch } = await import("../dist/lib/single-file-patch.js");
  const { getCheckpoint } = await import("../dist/lib/checkpoint.js");
  const file = path.join(dir, "source.ts");
  await fs.writeFile(file, "before\nconst value = 1;\nafter\n");

  const dry = await applySingleFilePatch({
    path: file, patch: "@@\n-const value = 1;\n+const value = 2;", dryRun: true,
  });
  assert.equal(dry.checkpoint_id, null);
  assert.equal(dry.dry_run, true);
  assert.match(dry.diff, /value = 2/);
  assert.match(await fs.readFile(file, "utf8"), /value = 1/);
  console.log("OK  dry-run previews without writes or checkpoints");

  await assert.rejects(
    applySingleFilePatch({
      path: file, patch: "*** Begin Patch\n*** Update File: source.ts\n@@\n-before\n+changed\n*** End Patch",
    }),
    /single-file/i,
  );
  assert.match(await fs.readFile(file, "utf8"), /before/);
  console.log("OK  multi-file patch format rejected before write");

  const changed = await applySingleFilePatch({
    path: file, patch: "@@\n-const value = 1;\n+const value = 2;",
  });
  assert.match(await fs.readFile(file, "utf8"), /value = 2/);
  assert.equal(changed.dry_run, false);
  assert.match(changed.checkpoint_id, /^cp_/);
  const checkpoint = await getCheckpoint(changed.checkpoint_id);
  assert.deepEqual(checkpoint.files, [file]);
  console.log("OK  single-file patch creates original rewind checkpoint");

  const foreign = path.join(dir, "foreign.ts");
  await fs.writeFile(foreign, "FOREIGN=1\n");
  const symlink = path.join(dir, "linked.ts");
  let linkCreated = false;
  try {
    await fs.symlink(foreign, symlink, "file");
    linkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
  }
  if (linkCreated) {
    await assert.rejects(applySingleFilePatch({
      path: symlink, patch: "@@\n-FOREIGN=1\n+FOREIGN=2", checkpointTool: "edit_and_verify",
    }), /symlink|unsafe|path/i);
    assert.equal(await fs.readFile(foreign, "utf8"), "FOREIGN=1\n", "symlink target must never be edited");
    console.log("OK  single-file patch rejects symlink targets without touching their referents");
  } else {
    console.log("SKIP direct symlink test (symlink creation unavailable)");
  }

  const foreignDir = path.join(dir, "foreign-dir");
  await fs.mkdir(foreignDir);
  await fs.writeFile(path.join(foreignDir, "other.ts"), "OTHER=1\n");
  const linkedDir = path.join(dir, "linked-dir");
  let ancestorCreated = false;
  try {
    await fs.symlink(foreignDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    ancestorCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
  }
  if (ancestorCreated) {
    await assert.rejects(applySingleFilePatch({
      path: path.join(linkedDir, "other.ts"), patch: "@@\n-OTHER=1\n+OTHER=2", checkpointTool: "edit_and_verify",
    }), /symlink|unsafe|path/i);
    assert.equal(await fs.readFile(path.join(foreignDir, "other.ts"), "utf8"), "OTHER=1\n");
    console.log("OK  single-file patch rejects symlink parent directories");
  } else {
    console.log("SKIP ancestor symlink test (symlink creation unavailable)");
  }

  const audit = await fs.readFile(path.join(dir, "audit.log"), "utf8");
  assert.match(audit, /"tool":"apply_patch"/);
  console.log("OK  shared patch preserves legacy audit event");
  console.log("\n4 baseline checks plus symlink checks, 0 failed");
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
}