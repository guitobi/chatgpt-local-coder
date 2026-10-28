# QA Hardening and Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute inline only; no subagents and no commits per user restrictions.

**Goal:** Resolve defensible owner-ranking failures, test large repository behavior, measure safe shell acceleration, and complete local-only security/MCP acceptance.

**Architecture:** Extend existing offline harness fixtures and source-ranking logic within the isolated QA worktree. Keep enumeration ignore-aware and security checks fail-closed. Treat command optimization as separate explicit execution semantics, never silently replace a shell.

**Tech Stack:** TypeScript, Node.js, ripgrep, PowerShell, MCP Streamable HTTP.

**Spec:** `docs/superpowers/specs/2026-10-28-qa-hardening-and-scale-design.md`

## Global Constraints

- No paid API, model quotas, ChatGPT Work, extra agents, tunnel, live data, main worktree edits, commits, pushes, or deploys.
- Operate only in `D:\\programatyvna_shlaypa(sandbox)\\chatgpt-local-coder-harness`, with disposable fixtures outside the repo.
- Retain all existing dirty worktree changes. No destructive Git commands.

## Review Focus

- A generic query matching a tool catalog and a tool registrar must prefer the latter when the task explicitly asks to expose/register an operation; do not hardcode a single gold file.
- A large repository containing >4,000 code candidates must not quietly claim comprehensive search if a relevant source is beyond the cap.
- Ignored, hidden, credential and symlink paths must never be exposed by either retrieval route.
- A shell performance path must not accidentally reinterpret quoting, operators, cwd directives, or authorization checks.
- Local MCP authentication, timeouts, checkpoint integrity and failure diagnostics must survive source changes.

## Task 1 — Source registrar relevance

**Files:** `scripts/test-task-context.mjs`, `src/lib/task-context.ts`, `scripts/bench-task-context.mjs`.

- [x] Add competing catalog/registrar fixtures, with a failing top-3 assertion for a generic tool-operation request.
- [x] Verify RED specifically from scoring, not fixture setup.
- [x] Add minimal bounded definition evidence from registered tool names and re-run GREEN.
- [x] Re-run 38 real queries and 12 multilingual synthetic cases; revert if quality drops.
- [x] Record actual miss, discriminative evidence and limitations.

## Task 2 — 1k/10k scaling and candidate truncation

**Files:** `scripts/bench-task-context-scale.mjs`, `scripts/test-task-context.mjs`, optionally `src/lib/task-context.ts`.

- [x] Add bounded 1k and 10k disposable-tree measurements of latency, memory and early/late owner rank.
- [x] Verify that any late-owner omission is reproduced in a failing test, not guessed from timings.
- [x] If an omission is real, change search safely and verify RED→GREEN; otherwise keep existing cap and report it.
- [x] Re-run existing relevance benchmarks and any new fixture test.

## Task 3 — Shell verification latency

**Files:** `scripts/bench-edit-phases.mjs`, `scripts/test-harness-operations.mjs`, possibly `src/lib/harness-operations.ts` and `src/tools/harness.ts`.

- [x] Repeat PowerShell-startup vs direct-argv phase profiling in disposable directories.
- [x] Define a strict command/argv contract and test security, output, failure, timeout, and cwd behavior before any implementation.
- [x] Implement only a proven safe *opt-in* path if cost and semantics justify it; leave ordinary shell commands unchanged.
- [x] Run benchmark and regressions; report remaining architectural overhead.

## Task 4 — Security, E2E and handoff

**Files:** tests appropriate to any confirmed issue; final findings in this plan.

- [x] Review symlink/ignore/redaction, timeout descendants, checkpoint/audit and local-only auth on the actual changed implementation.
- [x] Add RED tests and fix confirmed Important defects only, with a full local regression pass (no independent subagent per user restriction).
- [x] Run full `npm test` including localhost authenticated MCP E2E.
- [x] Run `git diff --check`; compare main Git status with unchanged baseline.
- [x] Record what cannot be measured without paid/model access or user quota.

## Execution record

- Baseline on 86 QA candidates: 38 owner queries, Hit@1 25, Hit@3 37, Hit@6 37, MRR 0.803. Original generic file read/write query has no accepted owner in top 8; `src/lib/tool-profile.ts` ranks above `src/tools/filesystem.ts`.
- Existing linked QA worktree verified; all dirty changes preserved. Main tree must stay unchanged.
- Task 1 RED: synthetic tool registrar `src/tools/io.ts` absent from top 3; three catalog files scored 106 each. Root cause: catalog descriptions contained all generic search words on one line, while genuine `registerTool("read_text_file")` and `registerTool("write_file")` names were treated as unrelated lexical mentions. GREEN: bounded registered-name evidence added only for explicit tool exposure/registration tasks, reading only existing ignore-filtered safe candidates. Real 38-query hit@1 27/38, hit@3 38/38, hit@6 38/38, MRR 0.842; synthetic language owners 12/12. `npm test` exit 0 with authenticated HTTP MCP. No source-owner labels changed.
- Task 2 RED: 4,100-file disposable repository reported `searched_files=4000` and failed to return a unique `z-tail.ts` at end of sorted enumeration. Root cause: content hits beyond the original first 4,000 were discarded by the early candidate set. GREEN: match all ignore-filtered enumerated paths using ripgrep, prioritize evidence and path matches into the same 4,000-candidate budget; late match now returns. No ignored source is included. Before 10k-scale median ~3,741 ms, late owner not found, RSS up to ~118 MB; after median ~3,191 ms, early/late found, peak RSS ~186 MB. Memory cost is reported, not hidden. Full `npm test` exit 0; 38 real queries remain 38/38 Hit@3; 12 synthetic owner queries remain 12/12 Hit@1.
- Task 3 RED: an explicit JSON argv verification was incorrectly sent to the shell (nonzero code normalized to 1), and malformed argv did not fail before patching. GREEN: `command_mode=argv` is an explicit opt-in on `edit_and_verify` and `diagnose_failure`, preserving existing shell defaults and authorization calls. Parses 1–32 nonempty bounded strings before any file changes, invokes a non-shell process with the existing process-tree timeout killer and bounded diagnostic tail. Direct process exit 7 and descendant cleanup were verified, malformed argv rejects pre-edit; authenticated localhost HTTP MCP also exercises the mode. Local p50 patch ~12 ms, shell verification ~260 ms, direct-argv verification ~69 ms, combined shell ~264 ms vs combined argv ~80 ms (8 warm samples). Does not make arbitrary shell commands automatically faster.
- Task 4 RED: `inspect_code` returned a `.gitignore`-ignored source from a disposable non-Git fixture; its original `grepSearch` path ran `rg --no-ignore`. Additional RED demonstrated an embedded PEM private-key body in the response. GREEN: only the inspection route enables `--no-require-git` and ignore-aware ripgrep, never falling back to an unsafe scanner; caller glob filters are applied after ignore enforcement. Excluded hidden/credential/key paths, added symlink and real-path validation and `O_NOFOLLOW` excerpt reads, masked sensitive source lines and all embedded PEM private-key lines, and populated all match text only from verified safe excerpts (other matches retain location, no raw source). Generic `grep` semantics were preserved. A second case asserts `glob="*.ts"` cannot override `.gitignore`. Targeted harness 22/22 passed. Full local `npm test` exit 0 including authenticated localhost HTTP MCP (9 core scenarios), tokenless rejection, descendants, snapshots/audit; `git diff --check` exit 0 (non-blocking CRLF warning). Main worktree Git status unchanged from the 11-entry pre-task baseline, including untracked user files; QA dirty state retained, no commit/push/deploy.
- Known limitations: the QA tool architecture deliberately accepts broad explicit local file/command access, so this is not a sandbox against a malicious authorized caller; `inspect_code` excerpts at most five distinct files, later matches provide path/line only. At 10k files task-context median is ~3.2 s with peak ~186 MB in this synthetic fixture; no end-to-end model correctness, perceived intelligence, model-token usage or live-tunnel reliability can be measured under the prohibition on paid API, ChatGPT Work/model quotas, and live tunnel. There was no independent subagent code review by instruction.