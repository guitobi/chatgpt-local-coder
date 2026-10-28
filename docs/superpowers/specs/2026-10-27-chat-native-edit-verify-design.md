# Chat-Native Harness — Single-File Edit and Verify

## Intent

Reduce ChatGPT Chat ↔ MCP round-trips for the common patch → targeted test loop. ChatGPT Chat remains the only reasoning controller. The local MCP server executes two explicitly requested, deterministic actions; it never chooses a patch, test, retry, rollback, or next step.

## Selected design and alternatives

1. **Separate `apply_patch` and `diagnose_failure` calls:** safest existing behavior but two round-trips and two opportunities for verbose context.
2. **Single-file `edit_and_verify` (selected):** reuse the exact legacy single-file patch path, checkpoint and post-edit hooks, then run the exact user/model-specified command and return bounded diagnostic evidence.
3. **Unrestricted multi-file edit/test/automatic rollback:** rejected for this increment. Existing multi-file patch is sequential and may partially succeed; shell verification can itself modify files, so automatic rollback cannot reliably undo it.

## Contract

`edit_and_verify`: `path` (required existing text file), `patch` (single-file hunk only), `command` (explicit test/build command), optional `working_directory`, `dry_run`, `timeout_ms` (up to 120000), `max_output_chars` (up to 20000).

- Reuse `requireWriteAllowed`, `validatePath`, `checkpointBefore`, `applyUnifiedPatchToText`, `enrichAfterEdit`, and `audit`. Extract a shared single-file patch operation, and switch legacy `apply_patch` single-file branch to it without changing legacy schemas or output.
- Reject multi-file patches, including `*** Begin Patch` blocks; this tool edits exactly the named file. Reject/skip verification if patching fails.
- `dry_run` calculates a diff but never saves a file, creates a checkpoint, runs hooks, or executes the command.
- A successful write runs the explicit command once via existing `diagnoseFailure` (authorization, timeout, bounded output, file-line locations and Git status). Do not retry or roll back on failure/timeout.
- If the verification runner itself fails to launch, report a bounded `verification_error` while preserving the applied-patch flag and checkpoint ID. Never claim the command succeeded.
- Return a structured `{patch, verification, ...}` response: clipped diff with explicit truncation, checkpoint ID, `patch_applied`, `verification_ran`, and overall `ok`; failing tests yield `ok:false` with their actual exit/timeout. Preserve checkpoint ID even on test failure.
- Annotate as a mutating command, never read-only. Log one compound invocation and retain existing permission checks. Do not execute any output from a test as instructions.

## Constraints and verification

- No ChatGPT Work, Codex app-server, secondary LLM, API, autonomous agent runtime, or separate subscription. No tool can bypass ChatGPT's own limits.
- No live daemon/tunnel restart, production deploy, commit/push, or edits to dirty original `main`. Use `feat/chat-native-harness` isolated worktree.
- TDD tests must prove green, red, dry run, invalid patch blocks command, timeout, bounded output, MCP schema/annotations, and legacy `apply_patch` unchanged.
- Run TypeScript build, focused tests, full `npm test`, and Git diff integrity checks. Report local-only results honestly.