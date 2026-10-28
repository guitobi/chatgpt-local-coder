# Opt-In Safe Multi-File Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, preflighted multi-file source patches in a single Chat-native MCP call.

**Architecture:** `safe:true` routes through a dedicated preflight/apply helper; old `apply_patch` remains unchanged by default. A complete checkpoint precedes writes; best-effort rollback explicitly reports failures.

**Tech Stack:** TypeScript, Node.js fs, existing patch/checkpoint/MCP utilities.

**Spec:** `docs/superpowers/specs/2026-10-27-safe-multifile-patch-design.md`

## Global Constraints

- Chat-only MCP, no Work mode or external reasoning calls.
- Worktree only, no live daemon or remote repo changes.
- The legacy `apply_patch` path remains backward compatible.

## Review Focus

- The second file has a bad hunk: none of the earlier valid edits may land.
- An add targets an existing file: preserve original content.
- Traversal or symlink escapes the base directory: reject before writing.
- An oversized file has an incomplete checkpoint: reject all edits.
- Write-time errors and post-edit hook failures: report rather than claim success.

### Task 1: Strict planning and checkpointing

**Files:** Create `src/lib/safe-multi-file-patch.ts`, create `scripts/test-safe-multi-file-patch.mjs`.

**Interfaces:** `applySafeMultiFilePatch(patch: string, options: {baseDir: string; dryRun?: boolean}): Promise<SafeMultiPatchResult>`.

- [ ] Write tests for valid two-file update, create, dry-run, late bad hunk, duplicate/path traversal, existing add and oversized checkpoint.
- [ ] Run targeted tests RED.
- [ ] Implement strict target preflight, all updates in memory, checkpoint, bounded diffs and best-effort commit rollback.
- [ ] Run targeted tests GREEN.

### Task 2: MCP opt-in and HTTP regression

**Files:** Modify `src/tools/filesystem.ts`, `scripts/test-chat-harness-http.mjs`, `README.md`, `package.json`.

- [ ] Write real authenticated HTTP safe-patch assertions; observe RED before registration.
- [ ] Add `safe:boolean` input to `apply_patch`; reject safe single-file mode and route multi-file to the helper, preserving legacy behavior.
- [ ] Run `npm run test:harness:http`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Report limitations and do not deploy without separate permission.