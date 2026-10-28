import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-safe-multi-"));
const previous = Object.fromEntries(["CHECKPOINT_ENABLED", "CHECKPOINT_PATH", "CHECKPOINT_MAX_FILE_BYTES", "POST_EDIT_HOOKS_CONFIG", "AUDIT_LOG_PATH"].map(key => [key, process.env[key]]));
const makePatch = (entries) => "*** Begin Patch\n" + entries.join("\n") + "\n*** End Patch";
const update = (file, from, to) => `*** Update File: ${file}\n@@\n-${from}\n+${to}`;

try {
  process.env.CHECKPOINT_ENABLED = "true";
  process.env.CHECKPOINT_PATH = path.join(dir, "checkpoints");
  process.env.POST_EDIT_HOOKS_CONFIG = path.join(dir, "missing-hooks.json");
  process.env.AUDIT_LOG_PATH = path.join(dir, "audit.log");
  const { applySafeMultiFilePatch } = await import("../dist/lib/safe-multi-file-patch.js");
  const { getCheckpoint, listCheckpoints } = await import("../dist/lib/checkpoint.js");
  const a = path.join(dir, "a.ts");
  const b = path.join(dir, "b.ts");
  await fs.writeFile(a, "const A = 1;\n");
  await fs.writeFile(b, "const B = 1;\n");
  const both = makePatch([update("a.ts", "const A = 1;", "const A = 2;"), update("b.ts", "const B = 1;", "const B = 2;")]);

  const dry = await applySafeMultiFilePatch(both, { baseDir: dir, dryRun: true });
  assert.equal(dry.checkpoint_id, null);
  assert.equal(dry.files.length, 2);
  assert.equal(await fs.readFile(a, "utf8"), "const A = 1;\n");
  assert.equal((await listCheckpoints()).length, 0);
  console.log("OK  dry run computes every file without modifying or checkpointing");

  const lateFailure = makePatch([update("a.ts", "const A = 1;", "const A = 3;"), update("b.ts", "MISSING", "BROKEN")]);
  await assert.rejects(applySafeMultiFilePatch(lateFailure, { baseDir: dir }), /Patch context not found/);
  assert.equal(await fs.readFile(a, "utf8"), "const A = 1;\n");
  assert.equal((await listCheckpoints()).length, 0);
  console.log("OK  invalid later hunk rejects entire batch before first write");

  const changed = await applySafeMultiFilePatch(both, { baseDir: dir });
  assert.equal(changed.files.length, 2);
  assert.equal(changed.files.every(entry => entry.ok), true);
  assert.match(changed.checkpoint_id, /^cp_/);
  assert.deepEqual((await getCheckpoint(changed.checkpoint_id)).files, [a, b]);
  assert.match(await fs.readFile(a, "utf8"), /A = 2/);
  assert.match(await fs.readFile(b, "utf8"), /B = 2/);
  console.log("OK  valid two-file patch has one complete rewind checkpoint");

  const createdPath = path.join(dir, "new.ts");
  const addition = makePatch(["*** Add File: new.ts\n+const NEW = true;"]);
  const created = await applySafeMultiFilePatch(addition, { baseDir: dir });
  assert.equal(await fs.readFile(createdPath, "utf8"), "const NEW = true;");
  assert.equal((await getCheckpoint(created.checkpoint_id)).files[0], createdPath);
  await assert.rejects(applySafeMultiFilePatch(addition, { baseDir: dir }), /already exists/);
  assert.equal(await fs.readFile(createdPath, "utf8"), "const NEW = true;");
  console.log("OK  additions do not overwrite existing files");

  const deletedPath = path.join(dir, "delete-me.ts");
  await fs.writeFile(deletedPath, "DELETE=1\n");
  const deleted = await applySafeMultiFilePatch(makePatch(["*** Delete File: delete-me.ts"]), { baseDir: dir });
  assert.equal(deleted.ok, true);
  assert.match(deleted.checkpoint_id, /^cp_/);
  await assert.rejects(fs.stat(deletedPath), { code: "ENOENT" });
  console.log("OK  valid deletion succeeds with its original checkpoint");

  const replaceParentBase = path.join(dir, "replace-parent");
  const replaceParent = path.join(replaceParentBase, "sub");
  await fs.mkdir(replaceParent, { recursive: true });
  const originalCheckpointWrite = fs.writeFile;
  let replacedParent = false;
  try {
    fs.writeFile = async (...args) => {
      const written = await originalCheckpointWrite(...args);
      if (!replacedParent && String(args[0]) === path.join(dir, "checkpoints", "index.json")) {
        await fs.rename(replaceParent, path.join(replaceParentBase, "original-sub"));
        await fs.mkdir(replaceParent);
        replacedParent = true;
      }
      return written;
    };
    const result = await applySafeMultiFilePatch(
      makePatch(["*** Add File: sub/new.ts\n+const NEW = 1;"]), { baseDir: replaceParentBase },
    );
    assert.equal(replacedParent, true, "fixture must replace the parent after preflight");
    assert.equal(result.ok, false, "safe create must reject a replaced parent directory");
    await assert.rejects(fs.stat(path.join(replaceParent, "new.ts")), { code: "ENOENT" });
    console.log("OK  create rejects real-directory replacement between preflight and write");
  } finally {
    fs.writeFile = originalCheckpointWrite;
  }

  const rollbackBase = path.join(dir, "rollback-race");
  await fs.mkdir(rollbackBase);
  const rollbackCreated = path.join(rollbackBase, "created.ts");
  const rollbackOriginal = path.join(rollbackBase, "original-created.ts");
  const rollbackExisting = path.join(rollbackBase, "existing.ts");
  await fs.writeFile(rollbackExisting, "EXISTING=1\n");
  const originalOpen = fs.open;
  const originalLstat = fs.lstat;
  let replacedCreated = false;
  try {
    fs.lstat = async (...args) => {
      const stat = await originalLstat(...args);
      if (replacedCreated && String(args[0]) === rollbackCreated) {
        // Simulate Windows filesystems reporting indistinguishable inode
        // metadata after the original path was replaced.
        const originalStat = await originalLstat(rollbackOriginal);
        stat.dev = originalStat.dev;
        stat.ino = originalStat.ino;
      }
      return stat;
    };
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === rollbackCreated && args[1] === "wx") {
        const nativeWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          const written = await nativeWrite(...writeArgs);
          await fs.rename(rollbackCreated, rollbackOriginal);
          await fs.writeFile(rollbackCreated, "INTRUDER=1\n");
          await fs.writeFile(rollbackExisting, "EXISTING=CHANGED\n");
          replacedCreated = true;
          return written;
        };
      }
      return handle;
    };
    const result = await applySafeMultiFilePatch(makePatch([
      "*** Add File: created.ts\n+CREATED=1",
      update("existing.ts", "EXISTING=1", "EXISTING=2"),
    ]), { baseDir: rollbackBase });
    assert.equal(replacedCreated, true, "fixture must replace the new file before rollback");
    assert.equal(result.ok, false);
    assert.equal(await fs.readFile(rollbackCreated, "utf8"), "INTRUDER=1\n",
      "rollback must not unlink a file with a different identity");
    console.log("OK  rollback never unlinks a replacement file");
  } finally {
    fs.open = originalOpen;
    fs.lstat = originalLstat;
  }

  const rejectedDelete = path.join(dir, "unlink-refused.ts");
  await fs.writeFile(rejectedDelete, "DO_NOT_DELETE=1\n");
  const nativeUnlink = fs.unlink;
  try {
    fs.unlink = async (...args) => {
      if (String(args[0]) === rejectedDelete) {
        throw Object.assign(new Error("simulated unlink denial"), { code: "EACCES" });
      }
      return nativeUnlink(...args);
    };
    const result = await applySafeMultiFilePatch(
      makePatch(["*** Delete File: unlink-refused.ts"]), { baseDir: dir },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.rollback, { attempted: false, complete: true, errors: [] },
      "failed unlink must not register an untouched file for rollback");
    assert.equal(await fs.readFile(rejectedDelete, "utf8"), "DO_NOT_DELETE=1\n");
    console.log("OK  failed deletion does not claim a failed rollback of an untouched file");
  } finally {
    fs.unlink = nativeUnlink;
  }

  await assert.rejects(applySafeMultiFilePatch(makePatch(["*** Add File: ../outside.ts\n+NOPE"]), { baseDir: dir }), /outside|base directory/i);
  await assert.rejects(applySafeMultiFilePatch(makePatch([update("a.ts", "const A = 2;", "A=3"), update("a.ts", "const A = 2;", "A=4")]), { baseDir: dir }), /duplicate/i);
  console.log("OK  traversal and repeated target paths rejected");

  const staleNumbered = makePatch(["*** Update File: a.ts\n@@ -1,1 +1,1 @@\n-const EXPECTED = 1;\n+const A = 999;"]);
  await assert.rejects(applySafeMultiFilePatch(staleNumbered, { baseDir: dir }), /context|mismatch|expected/i);
  assert.equal(await fs.readFile(a, "utf8"), "const A = 2;\n");
  console.log("OK  numbered hunk must match original source before replacing it");

  let testedSymlink = false;
  try {
    await fs.symlink(dir, path.join(dir, "alias"), process.platform === "win32" ? "junction" : "dir");
    testedSymlink = true;
  } catch (error) {
    if (!(["EPERM", "EACCES", "ENOTSUP"].includes(error.code))) throw error;
  }
  if (testedSymlink) {
    await assert.rejects(applySafeMultiFilePatch(makePatch(["*** Add File: alias/escaped.ts\n+NOPE"]), { baseDir: dir }), /Unsafe parent directory/);
    console.log("OK  symlink parent cannot redirect safe patch writes");

    const raceBase = path.join(dir, "race-base");
    const safeParent = path.join(raceBase, "sub");
    const renamedParent = path.join(raceBase, "sub-original");
    const outsideParent = path.join(dir, "outside");
    await fs.mkdir(safeParent, { recursive: true });
    await fs.mkdir(outsideParent);
    const raceFile = path.join(safeParent, "victim.ts");
    const outsideFile = path.join(outsideParent, "victim.ts");
    await fs.writeFile(raceFile, "VALUE=1\n");
    await fs.writeFile(outsideFile, "VALUE=1\n");
    const originalRead = fs.readFile;
    let reads = 0;
    let swapped = false;
    try {
      fs.readFile = async (...args) => {
        const value = await originalRead(...args);
        if (String(args[0]) === raceFile && ++reads === 3) {
          await fs.rename(safeParent, renamedParent);
          await fs.symlink(outsideParent, safeParent, process.platform === "win32" ? "junction" : "dir");
          swapped = true;
        }
        return value;
      };
      try {
        await applySafeMultiFilePatch(makePatch([update("sub/victim.ts", "VALUE=1", "VALUE=2")]), { baseDir: raceBase });
      } catch (error) {
        assert.match(String(error), /unsafe|changed|target|file|path|identity/i);
      }
      assert.equal(swapped, true, "test must exercise a real parent replacement after commit read");
      assert.equal(await originalRead(outsideFile, "utf8"), "VALUE=1\n", "race must never write outside the base");
      console.log("OK  parent replacement after content verification cannot redirect update");
    } finally {
      fs.readFile = originalRead;
      if (swapped) {
        await fs.unlink(safeParent);
        await fs.rename(renamedParent, safeParent);
      }
    }

    const deleteBase = path.join(dir, "delete-race");
    const deleteParent = path.join(deleteBase, "sub");
    const deleteBackup = path.join(deleteBase, "sub-original");
    const deleteOutside = path.join(dir, "delete-outside");
    await fs.mkdir(deleteParent, { recursive: true });
    await fs.mkdir(deleteOutside);
    const deleteTarget = path.join(deleteParent, "victim.ts");
    const deleteOutsideFile = path.join(deleteOutside, "victim.ts");
    await fs.writeFile(deleteTarget, "SAFE=1\n");
    await fs.writeFile(deleteOutsideFile, "OUTSIDE=1\n");
    const readBeforeDelete = fs.readFile;
    let deleteReads = 0;
    let deleteSwapped = false;
    try {
      fs.readFile = async (...args) => {
        const value = await readBeforeDelete(...args);
        if (String(args[0]) === deleteTarget && ++deleteReads === 3) {
          await fs.rename(deleteParent, deleteBackup);
          await fs.symlink(deleteOutside, deleteParent, process.platform === "win32" ? "junction" : "dir");
          deleteSwapped = true;
        }
        return value;
      };
      try {
        await applySafeMultiFilePatch(makePatch(["*** Delete File: sub/victim.ts"]), { baseDir: deleteBase });
      } catch (error) {
        assert.match(String(error), /unsafe|changed|target|file|path|identity/i);
      }
      assert.equal(deleteSwapped, true, "delete race must actually replace the parent");
      assert.equal(await readBeforeDelete(deleteOutsideFile, "utf8"), "OUTSIDE=1\n",
        "delete race must not unlink an outside file");
      console.log("OK  parent replacement after delete preflight cannot unlink outside target");
    } finally {
      fs.readFile = readBeforeDelete;
      if (deleteSwapped) {
        await fs.unlink(deleteParent);
        await fs.rename(deleteBackup, deleteParent);
      }
    }
  }

  process.env.CHECKPOINT_MAX_FILE_BYTES = "4";
  const beforeCount = (await listCheckpoints()).length;
  await assert.rejects(applySafeMultiFilePatch(makePatch([update("a.ts", "const A = 2;", "const A = 9;")]), { baseDir: dir }), /checkpoint|snapshot|size limit/i);
  assert.equal(await fs.readFile(a, "utf8"), "const A = 2;\n");
  assert.equal((await listCheckpoints()).length, beforeCount);
  delete process.env.CHECKPOINT_MAX_FILE_BYTES;
  process.env.CHECKPOINT_ENABLED = "false";
  await assert.rejects(applySafeMultiFilePatch(makePatch([update("a.ts", "const A = 2;", "const A = 9;")]), { baseDir: dir }), /checkpoint.*enabled/i);
  assert.equal(await fs.readFile(a, "utf8"), "const A = 2;\n");
  console.log("OK  disabled or incomplete checkpoints block safe edits");

  process.env.CHECKPOINT_ENABLED = "true";
  const hookConfig = path.join(dir, "hooks.json");
  await fs.writeFile(hookConfig, JSON.stringify({ enabled: true, hooks: [{ glob: "*.ts", command: "exit 13" }] }));
  process.env.POST_EDIT_HOOKS_CONFIG = hookConfig;
  const hooked = await applySafeMultiFilePatch(makePatch([update("a.ts", "const A = 2;", "const A = 9;")]), { baseDir: dir });
  assert.equal(hooked.ok, false);
  assert.equal(hooked.hooks.failed, 1);
  assert.equal(hooked.rollback.attempted, false);
  assert.match(hooked.checkpoint_id, /^cp_/);
  assert.equal(await fs.readFile(a, "utf8"), "const A = 9;\n");
  console.log("OK  failing post-edit hook is visible and does not secretly revert changes");

  console.log(`\n${testedSymlink ? 15 : 12} passed, 0 failed${testedSymlink ? "" : ", symlink case skipped"}`);
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
}