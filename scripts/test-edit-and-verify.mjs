import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-edit-verify-"));
const previous = {
  CHECKPOINT_PATH: process.env.CHECKPOINT_PATH,
  CHECKPOINT_ENABLED: process.env.CHECKPOINT_ENABLED,
  CHECKPOINT_MAX_FILE_BYTES: process.env.CHECKPOINT_MAX_FILE_BYTES,
  POST_EDIT_HOOKS_CONFIG: process.env.POST_EDIT_HOOKS_CONFIG,
  AUDIT_LOG_PATH: process.env.AUDIT_LOG_PATH,
};

try {
  process.env.CHECKPOINT_PATH = path.join(dir, "checkpoints");
  process.env.CHECKPOINT_ENABLED = "true";
  process.env.POST_EDIT_HOOKS_CONFIG = path.join(dir, "absent-hooks.json");
  process.env.AUDIT_LOG_PATH = path.join(dir, "audit.log");
  const { editAndVerify } = await import("../dist/lib/harness-operations.js");
  const { getCheckpoint, listCheckpoints } = await import("../dist/lib/checkpoint.js");
  const source = path.join(dir, "source.ts");
  await fs.writeFile(source, "VALUE=1\n");

  const dry = await editAndVerify({
    path: source, patch: "@@\n-VALUE=1\n+VALUE=2", dryRun: true,
    command: "node -e \"require('fs').writeFileSync('ran.txt','yes')\"",
    workingDirectory: dir,
  });
  assert.equal(dry.patch_applied, false);
  assert.equal(dry.verification_ran, false);
  assert.equal(dry.patch.checkpoint_id, null);
  assert.equal(await fs.readFile(source, "utf8"), "VALUE=1\n");
  await assert.rejects(fs.access(path.join(dir, "ran.txt")), { code: "ENOENT" });
  assert.equal((await listCheckpoints()).length, 0);
  console.log("OK  dry-run does not apply patch, checkpoint or execute command");

  await assert.rejects(editAndVerify({
    path: source, patch: "@@\n-NOT_THERE\n+X",
    command: "node -e \"require('fs').writeFileSync('ran.txt','yes')\"",
    workingDirectory: dir,
  }), /Patch context not found/);
  assert.equal((await listCheckpoints()).length, 0);
  await assert.rejects(fs.access(path.join(dir, "ran.txt")), { code: "ENOENT" });
  console.log("OK  invalid patch never triggers command or checkpoint");

  const invalidArgvSource = path.join(dir, "invalid-argv.ts");
  await fs.writeFile(invalidArgvSource, "Q=1\n");
  await assert.rejects(editAndVerify({
    path: invalidArgvSource, patch: "@@\n-Q=1\n+Q=2",
    command: "this is not JSON", commandMode: "argv", workingDirectory: dir,
  }), /argument vector|argv|JSON/i);
  assert.equal(await fs.readFile(invalidArgvSource, "utf8"), "Q=1\n");
  console.log("OK  malformed direct argv is rejected before checkpoint or edit");

  const staleNumbered = "@@ -1,1 +1,1 @@\n-STALE=7\n+VALUE=999";
  await assert.rejects(editAndVerify({
    path: source, patch: staleNumbered,
    command: "node --version", workingDirectory: dir,
  }), /context|mismatch/i);
  assert.equal(await fs.readFile(source, "utf8"), "VALUE=1\n");
  assert.equal((await listCheckpoints()).length, 0);
  console.log("OK  stale numbered edit_and_verify patch is rejected without writing");

  process.env.CHECKPOINT_ENABLED = "false";
  try {
    await assert.rejects(editAndVerify({
      path: source, patch: "@@\n-VALUE=1\n+VALUE=99",
      command: "node --version", workingDirectory: dir,
    }), /checkpoint/i);
    assert.equal(await fs.readFile(source, "utf8"), "VALUE=1\n");
    assert.equal((await listCheckpoints()).length, 0);
    console.log("OK  edit_and_verify refuses edits when checkpoints are disabled");
  } finally {
    process.env.CHECKPOINT_ENABLED = "true";
  }

  const success = await editAndVerify({
    path: source, patch: "@@\n-VALUE=1\n+VALUE=2",
    command: "node -e \"if(!require('fs').readFileSync('source.ts','utf8').includes('VALUE=2'))process.exit(5)\"",
    workingDirectory: dir,
  });
  assert.equal(success.patch_applied, true);
  assert.equal(success.verification_ran, true);
  assert.equal(success.ok, true);
  assert.equal(success.verification.exit_code, 0);
  assert.match(success.patch.checkpoint_id, /^cp_/);
  assert.deepEqual((await getCheckpoint(success.patch.checkpoint_id)).files, [source]);
  console.log("OK  patch and explicit passing test run in one operation");

  const argvSource = path.join(dir, "argv-source.ts");
  await fs.writeFile(argvSource, "Q=1\n");
  const direct = await editAndVerify({
    path: argvSource, patch: "@@\n-Q=1\n+Q=2",
    command: JSON.stringify([process.execPath, "-e",
      "if(!require('fs').readFileSync('argv-source.ts','utf8').includes('Q=2'))process.exit(7)"]),
    commandMode: "argv", workingDirectory: dir,
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.verification.exit_code, 0);
  assert.ok(await getCheckpoint(direct.patch.checkpoint_id));
  console.log("OK  explicit direct argv verification runs after checkpointed patch");

  const failure = await editAndVerify({
    path: source, patch: "@@\n-VALUE=2\n+VALUE=3",
    command: "node -e \"console.error('src/source.ts:3:2: failure'); process.exit(7)\"",
    workingDirectory: dir, maxOutputChars: 128,
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.patch_applied, true);
  assert.equal(failure.verification_ran, true);
  assert.notEqual(failure.verification.exit_code, 0);
  assert.ok(failure.verification.locations.some(loc => loc.line === 3));
  assert.match(await fs.readFile(source, "utf8"), /VALUE=3/);
  assert.ok(await getCheckpoint(failure.patch.checkpoint_id));
  console.log("OK  failing test keeps edit and rewind checkpoint with diagnostics");

  const timeout = await editAndVerify({
    path: source, patch: "@@\n-VALUE=3\n+VALUE=4",
    command: "node -e \"setTimeout(()=>{},4000)\"",
    workingDirectory: dir, timeoutMs: 100,
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.verification.timed_out, true);
  assert.ok(await getCheckpoint(timeout.patch.checkpoint_id));
  console.log("OK  timeout is reported and checkpoint retained");

  {
    const previousLimit = process.env.CHECKPOINT_MAX_FILE_BYTES;
    try {
      process.env.CHECKPOINT_MAX_FILE_BYTES = "4";
      const before = await fs.readFile(source, "utf8");
      const checkpointCount = (await listCheckpoints()).length;
      await assert.rejects(editAndVerify({
        path: source, patch: "@@\n-VALUE=4\n+VALUE=5",
        command: "node -e \"require('fs').writeFileSync('ran.txt','yes')\"",
        workingDirectory: dir,
      }), /checkpoint|snapshot|size limit/i);
      assert.equal(await fs.readFile(source, "utf8"), before);
      assert.equal((await listCheckpoints()).length, checkpointCount);
      await assert.rejects(fs.access(path.join(dir, "ran.txt")), { code: "ENOENT" });
      console.log("OK  checkpoint size limit blocks edit before file changes");
    } finally {
      if (previousLimit === undefined) delete process.env.CHECKPOINT_MAX_FILE_BYTES;
      else process.env.CHECKPOINT_MAX_FILE_BYTES = previousLimit;
    }
  }

  if (process.platform === "win32") {
    const previousShell = process.env.SHELL;
    try {
      process.env.SHELL = "C:\\local-coder-missing-shell\\pwsh.exe";
      const unavailable = await editAndVerify({
        path: source, patch: "@@\n-VALUE=4\n+VALUE=5",
        command: "node --version", workingDirectory: dir,
      });
      assert.equal(unavailable.ok, false);
      assert.equal(unavailable.patch_applied, true);
      assert.equal(unavailable.verification_ran, false);
      assert.equal(unavailable.verification, null);
      assert.match(unavailable.verification_error, /spawn|ENOENT/i);
      assert.match(await fs.readFile(source, "utf8"), /VALUE=5/);
      assert.ok(await getCheckpoint(unavailable.patch.checkpoint_id));
      console.log("OK  unavailable shell returns checkpoint instead of losing it in thrown error");
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
    }
  }

  const large = "Z".repeat(12000);
  await fs.writeFile(source, large + "\n");
  const bounded = await editAndVerify({
    path: source, patch: "@@\n-" + large + "\n+" + "Y".repeat(12000),
    command: "node -e \"console.log('X'.repeat(4000))\"",
    workingDirectory: dir, maxOutputChars: 128,
  });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.patch.diff_truncated, true);
  assert.ok(bounded.patch.diff.length <= 4000);
  assert.ok(bounded.verification.stdout.text.length <= 128);
  assert.equal(bounded.verification.stdout.truncated, true);
  console.log("OK  long diffs and command output are explicitly bounded");

  const hookPath = path.join(dir, "configured-hooks.json");
  const hookSource = path.join(dir, "hooked.ts");
  await fs.writeFile(hookSource, "HOOK=1\n");
  await fs.writeFile(hookPath, JSON.stringify({
    enabled: true,
    hooks: [{ glob: "*.ts", command: "exit 13" }],
  }));
  process.env.POST_EDIT_HOOKS_CONFIG = hookPath;
  const hooked = await editAndVerify({
    path: hookSource, patch: "@@\n-HOOK=1\n+HOOK=2",
    command: "node --version", workingDirectory: dir,
  });
  assert.equal(hooked.verification.exit_code, 0);
  assert.equal(hooked.ok, false, "failing post-edit hook must not be hidden behind passing verification");
  assert.equal(hooked.patch.hooks.executed, 1);
  assert.equal(hooked.patch.hooks.failed, 1);
  assert.equal(hooked.patch.hooks.results[0].exit_code, 13);
  assert.match(await fs.readFile(hookSource, "utf8"), /HOOK=2/);
  console.log("OK  post-edit hook failure is visible even if explicit test passes");

  console.log(`\n${process.platform === "win32" ? 13 : 12} passed, 0 failed`);
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
}