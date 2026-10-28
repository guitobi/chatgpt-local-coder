# Chat-Native Harness Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Eliminate the six audited patch, checkpoint, path-race, timeout, and log-bounding defects without modifying the active connector.

**Architecture:** Keep the existing single-file and safe-multi-file APIs. Fail closed on stale numbered hunks or unavailable checkpoints. Use handle-based constrained file access for safe updates and explicit process-tree termination and bounded capture for shell commands.

**Tech Stack:** Node.js 24, TypeScript, existing node:assert regression scripts and synthetic MCP HTTP E2E.

**Spec:** User-approved audit remediation checklist of October 27, 2026.

## Global Constraints

- Work only in linked `feat/chat-native-harness` worktree.
- No commit, push, merge, deploy or active MCP server/tunnel restart.
- Run regression RED before implementation GREEN for each task.
- Only synthetic fixtures and disposable processes; never live service data.
- Preserve legacy unnumbered patch behavior unless required for safety.

## Review Focus

- Zero-length hunks at start, middle and EOF; reject inconsistent counts.
- Stale numbered patch must not change a file or create a checkpoint.
- Disabled/oversized checkpoint must prevent a promised reversible edit.
- Replaced symlink/ancestor during commit must not redirect an update outside base.
- Timeout must end nested descendants, and high-volume stdout/stderr must stay memory-bounded.

---

### Task 1: Numbered unified diff correctness

**Files:** `src/lib/patch.ts`, `scripts/test-patch.mjs`

- [x] Add positive tests for zero-length insertion at beginning/middle/EOF and strict rejection of malformed counts.
- [x] Run `npm run build` and `node scripts/test-patch.mjs` to verify RED.
- [x] Parse hunk counts; use zero-based insertion anchors for oldCount=0; verify counts in strict mode.
- [x] Verify GREEN with the same commands.

### Task 2: Strict single-file editing and checkpoint

**Files:** `src/lib/single-file-patch.ts`, `scripts/test-edit-and-verify.mjs`

- [x] Test stale numbered edit rejects unchanged source; test CHECKPOINT_ENABLED=false prevents modification.
- [x] Verify RED for stale numbered edit.
- [x] Enable strict numbered matching for `edit_and_verify` and require actual checkpoint ID on non-dry-run.
- [x] Verify GREEN.

### Task 3: Close safe file-path races

**Files:** `src/lib/safe-multi-file-patch.ts`, `scripts/test-safe-multi-file-patch.mjs`

- [x] Test preflight-to-write target replacement and malicious symlink at write/rollback boundary where supported.
- [x] Verify RED for path replacement and rollback regressions.
- [x] Revalidate the path at commit; use file handles and no-follow opens when available, compare identity to preflight; fail closed if identity changes.
- [x] Verify GREEN on Windows and Linux.

### Task 4: Process tree timeout and bounded log capture

**Files:** `src/lib/persistent-shell.ts`, `scripts/test-harness-operations.mjs`

- [x] Test child process survival after timeout and bounded captured stream output before response formatting.
- [x] Verify RED for surviving child process.
- [x] Implement platform-specific descendant termination and capped tail buffers; retain useful diagnostics.
- [x] Verify GREEN.

### Task 5: Full verification

**Files:** Existing E2E and test scripts.

- [x] Run `npm test`, `npm run build`, synthetic authenticated HTTP MCP E2E and disposable Linux container smoke test.
- [x] Inspect `git diff --check` and changed file list.
- [x] Self-review for remaining high-severity gaps; report any unverified platform behavior separately.

## Implementation result (2026-10-27)

- Tasks 1-5 implemented in the existing isolated worktree; no commit, push, deploy or live connector restart.
- Regressions cover all audited categories; pre-fix failures were directly observed for numbered hunks, stale edits, update/delete path swaps and surviving child processes. The checkpoint and bounded-buffer cases are covered by passing assertions.
- Extra coverage: parent junction replacement during both update and delete; successful normal deletion.
- Follow-up regressions: reject real-directory parent replacement on create; rollback cannot unlink a substituted newly created file; a failed unlink before modification must not report an incomplete rollback. Last regression observed RED, then GREEN on Windows/Linux (safe multi-file suite 15/15).
- Windows: `npm test` exit 0, including authenticated synthetic HTTP MCP E2E; `git diff --check` exit 0.
- Linux: disposable Node 22 Debian container, no network/ports, read-only mounts excluding `.env`: all selected regression suites and authenticated HTTP E2E pass.
- Local HTTP benchmark (12 warm samples): separate calls p50 242.7ms, compound call p50 235.0ms; response 1095B versus 958B. Conditional context 38479B full versus 385B unchanged. Not a ChatGPT UI/model latency benchmark.
- **Residual security limit:** Node's portable path-based `create`/`unlink` operations lack an atomic directory-relative no-follow API. Parent swaps in the final system-call window cannot be proven impossible. Updates are written through inode-checked handles; deletes use an identity check immediately before unlink. Deployment under an actively hostile concurrent filesystem writer requires stronger OS-specific primitives or workload isolation.
- Real ChatGPT browser E2E remains unverified: the available isolated Chrome session is logged out. Registration of a separate test connector was not attempted; the active server, tunnel and connected app were not modified.

## Isolated QA connector attempt (2026-10-27)

- Started the hardened branch in a non-root, read-only Linux Docker container, mounting only compiled code/dependencies read-only and synthetic `/qa`/`/tmp` temporary filesystems. Published only an ephemeral `127.0.0.1` port; unrelated containers and active connector untouched.
- Authenticated MCP `initialize`, `tools/list`, `write_file`, `apply_patch`, and `read_text_file` all passed on that actual QA process with synthetic text.
- A separate Cloudflare quick tunnel failed before obtaining a URL: `api.trycloudflare.com/tunnel` timed out; a direct Windows HTTPS request to that endpoint also timed out. The existing OpenAI tunnel uses a different profile/credential and was not reused or restarted.
- Genuine ChatGPT UI E2E remains blocked on a separately reachable test endpoint and an authenticated test browser session. The exact QA container, Docker network and tunnel log directory were removed after this attempt (all cleanup commands exited 0).