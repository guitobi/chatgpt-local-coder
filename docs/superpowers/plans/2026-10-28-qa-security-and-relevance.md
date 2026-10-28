# QA Security and Retrieval Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Inline execution authorized; no subagents or commits.

**Goal:** Test and harden path-safe single-file patching, evaluate task-aware context quality, and verify the complete QA MCP flow offline.

**Architecture:** Add independent disposable regression fixtures first, apply minimal fixes to `src/lib/single-file-patch.ts` and (only if needed) `src/lib/task-context.ts`, and test over existing HTTP MCP harness. No new dependencies.

**Tech Stack:** Node.js 24, TypeScript, filesystem handles, ripgrep, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-10-28-qa-security-and-relevance-design.md`

## Global Constraints

- No API keys, billed models, ChatGPT Work, external network, main worktree changes, commits, push or deploy.
- Preserve old patch syntax and checkpoint/hook contracts; keep all tests on isolated synthetic files.
- Do not claim model-level speed or quality improvements from local tool benchmarks.

## Review Focus

- A symbolic-link target or ancestor must never redirect a write outside the named file.
- A target replaced between preflight and write must fail closed, even with equal contents.
- Disabled or incomplete checkpoints must still block guaranteed-rollback edits.
- Ranking should put a relevant implementation ahead of an incidental occurrence.
- E2E must not open a public listener or access a live tunnel.

### Task 1: Single-file write identity

**Files:** `scripts/test-single-file-patch.mjs`, `src/lib/single-file-patch.ts`.

**Interface:** Keep `applySingleFilePatch(options):Promise<SingleFilePatchResult>` unchanged.

- [ ] Add direct/parent symlink and target-change tests to the disposable fixture; run them and observe RED.
- [ ] Protect the target with no-follow file opening, validated file identity, stable content and handle-bound writes; preserve checkpoint before edit.
- [ ] Run `node scripts/test-single-file-patch.mjs` and `node scripts/test-edit-and-verify.mjs` GREEN.

### Task 2: Task-context safety and relevance

**Files:** `scripts/test-task-context.mjs`, `src/lib/task-context.ts`, `scripts/bench-task-context.mjs` if needed.

**Interface:** Keep `buildTaskContext(options):Promise<TaskContextResult>` unchanged.

- [ ] Extend synthetic queries with hand-labeled expected implementation/test, including generic distracting words and non-code/ignored paths.
- [ ] Observe RED for any verified retrieval or read-safety defect; make the smallest supported fix and run GREEN.
- [ ] Report top-k accuracy, payload bounds and warm local latency; do not invoke external models.

### Task 3: QA acceptance and review

**Files:** `scripts/test-chat-harness-http.mjs` only if coverage needs extension.

- [ ] Verify in-process MCP registration and localhost-only authenticated HTTP E2E including new safeguards.
- [ ] Run complete `npm test` and local A/B; inspect code diff for security regressions.
- [ ] Check active/main worktree untouched; report remaining risks separately, without deploying.

## Offline retrieval follow-up (2026-10-28)

- Test-first failure: task terms scattered across a source file, or repeated in a benchmark prompt, could outrank the actual implementation. Scoring now treats code symbols as stronger evidence, while excluding benchmark/test scripts from that extra boost.
- Implementation locations now include `src/`, `app/`, `lib/`, `pkg/`, `internal/`, `server/`, and `client/`, with bounded reads of shortlisted candidates. An additional Python `app/` fixture verifies this behavior.
- Regression: `node scripts/test-task-context.mjs` -> 11/11; full `npm test` -> exit 0.
- Human-labeled local owner retrieval (six tasks): Hit@1 4/6, Hit@3 5/6, Hit@6 6/6, MRR 0.778. Warm search p50 132.7 ms, p95 143.5 ms (12 samples).
- Local MCP A/B (12 samples): edit p50 main 249.6 ms, QA 253.7 ms; edit calls main 2, QA 1; edit response main 1872 B, QA 1011 B. Repeated context main 47670 B, QA 371 B. Editing itself is **not proven faster**.
- Limits: the `persistent-shell.ts` owner ranks 6th for the generic timeout/child-process query; lexical retrieval is not a model-level quality test. No live UI/model, paid API, ChatGPT Work, tunnel or main-worktree changes.

## Hook subprocess review (2026-10-28)

- Separate `codex-hooks.ts` execution path had the same timeout-child leak and unbounded stdout problem as `persistent-shell.ts` had previously. A three-case test was observed RED for both unbounded output and a descendant writing after timeout, then GREEN after targeted fixes.
- Hook stdout retains at most 64 KiB, stderr is drained, POSIX process groups are terminated on timeout, and Windows uses `taskkill.exe /T /F` for the hook process tree (with a best-effort wrapper fallback).
- `node scripts/test-codex-hooks.mjs` -> 3/3; `npm test` -> exit 0, including authenticated localhost HTTP E2E. This remains an isolated QA verification, not proof on all OS/filesystems.