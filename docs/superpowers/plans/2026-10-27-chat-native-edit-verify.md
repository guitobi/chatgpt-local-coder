# Chat-Native Edit and Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe single-file edit-and-test action for ChatGPT Chat with one MCP round-trip.

**Architecture:** Extract the existing single-file `apply_patch` sequence into `src/lib/single-file-patch.ts`; reuse it from both old and new tools. Compose it with `diagnoseFailure`, preserving checkpoints, permission checks and bounded structured evidence.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Zod, Node assertion scripts.

**Spec:** `docs/superpowers/specs/2026-10-27-chat-native-edit-verify-design.md`

## Global Constraints

- Use ChatGPT Chat as the sole model runtime, never Work or secondary model APIs.
- Change only `feat/chat-native-harness`; no live service restart, commit, push, or deploy.
- Never automatically roll back changes after a failed test; the command may itself have mutated files.
- Preserve `apply_patch` legacy behavior, permissions, checkpointing and hooks.

## Review Focus

- Multi-file patch passed to a single-file tool must be rejected before writing/verification.
- Incorrect hunk must not execute verification or create checkpoint.
- Dry run must never execute a command, write file or create checkpoint.
- Failing/time-limited test must retain patched file and checkpoint and report accurate state.
- Test output and long diffs remain bounded; the error trace stays useful.

---

### Task 1: Extract shared single-file patch behavior

**Files:** Create `src/lib/single-file-patch.ts`; modify `src/tools/filesystem.ts`; create `scripts/test-single-file-patch.mjs`.

**Interfaces:** Export `applySingleFilePatch({path, patch, dryRun?, checkpointTool?}): Promise<{path, diff, dry_run, checkpoint_id, ...}>`. Consume existing patch/parser/checkpoint/hooks/permissions routines.

- [x] Write test covering patch, checkpoint, dry run and rejection of multi-file format.
- [x] Build and run test RED before implementation.
- [x] Extract shared operation and delegate the legacy `apply_patch` single-file branch to it, retaining its return payload.
- [x] Build and targeted tests GREEN; check legacy patch tests.

### Task 2: Compose edit with explicit verification

**Files:** Modify `src/lib/harness-operations.ts`; modify `scripts/test-harness-operations.mjs`.

**Interfaces:** Export `editAndVerify({path,patch,command,workingDirectory?,dryRun?,maxOutputChars?,timeoutMs?})` returning patch metadata and `DiagnosisResult | null` with flags.

- [x] Write failing tests for successful verification, failed tests, timeout, dry run, invalid patch and bounded diff/logs.
- [x] Build and run tests RED.
- [x] Implement with shared patch helper, then `diagnoseFailure` only when patch was successfully written.
- [x] Build and targeted tests GREEN.

### Task 3: Expose through MCP and verify

**Files:** Modify `src/tools/harness.ts`, `src/lib/tool-profile.ts`, `scripts/test-harness-registration.mjs`, `scripts/test-tool-profile.mjs`, `package.json`, `README.md`.

**Interfaces:** Register `edit_and_verify` in slim/full, command annotation, bounded Zod schema, audit, and `toolResult`.

- [x] Add failing in-memory MCP registration and invocation tests.
- [x] Run RED; implement tool and profile integration.
- [x] Run targeted MCP tests, full `npm test`, `npm run build`, `git diff --check`, and inspect Git status.
- [x] Report verification and remaining integration limits. Do not deploy.