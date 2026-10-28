# Offline Full-Workflow A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and TDD. No commits, subagents or external calls as required by the user.

**Goal:** Benchmark one complete scripted fix workflow in main versus QA, with correctness assertions and offline performance metrics.

**Architecture:** Extend the existing synthetic MCP A/B script. Each sample resets a real broken JavaScript source; the main and QA clients then run a failing test, discover and read the implementation, patch it and verify the test. A separate smoke test checks the emitted JSON contract.

**Tech Stack:** Node.js, MCP SDK Streamable HTTP, `node:test`, isolated temp files, Windows loopback.

**Spec:** `docs/superpowers/specs/2026-10-28-offline-workflow-ab-design.md`

## Global Constraints

- No API, Work, model calls, user limits, external network, tunnel, main writes/builds, live restart, commit, push or deploy.
- QA worktree already exists on `feat/chat-native-harness`; preserve all existing modifications.
- Synthetic files only, under disposable directories, with mandatory `finally` cleanup.

## Review Focus

- Baseline test must really fail before patch; smoke test asserts failure was observed.
- Selected owner must originate from the search result; smoke test asserts correct source.
- Patch verification must really pass; smoke test asserts repaired content and test exit 0.
- Other `grep` matches, ignored decoys and tests must not become edit targets.
- Commands must not inherit API credentials, contact upstream or leave processes/files behind.

### Task 1: RED — smoke contract for full workflow

**Files:** Create `scripts/test-bench-workflow-ab.mjs`.

**Interfaces:** Executes `node scripts/bench-local-ab.mjs --workflow-only` with a timeout. Reads JSON rows `{version,scenario:"full_workflow",samples,calls_per_sample,failed_test_observed,correct_source,verification_passed,p50_ms,p95_ms,avg_response_bytes}`.

- [x] Write a test that starts the real offline MCP benchmark and requires main and QA rows with 3 successful measured trials, real test failures observed, correct source paths, and final pass; 5 calls main, 4 QA.
- [x] Run `node scripts/test-bench-workflow-ab.mjs`; observed expected FAIL: `main must report a full-workflow result`.

### Task 2: GREEN — implement disposable workflow

**Files:** Modify `scripts/bench-local-ab.mjs`.

**Interfaces:** Add `sampleWorkflow(name,run)`; add workflow metric arrays, owner-selection assertions, `--workflow-only` smoke mode with 1 warmup +3 samples. Reuse `launch`, `call`, `runtimes`, `populateSearchFixture` and `finally` cleanup.

- [x] Add synthetic `src/invoice.mjs` and `tests/invoice.test.mjs`, reset broken source before each run.
- [x] Execute failing test on both servers, assert nonzero exit.
- [x] Find source from returned `grep` (main) or `task_context` (QA) results; assert correct owner and read its broken line.
- [x] Apply patch and verify a passing test with main two calls or QA one call; assert changed bytes and structured status.
- [x] Emit p50/p95, MCP calls, response bytes and correctness counts; skip earlier microbenchmarks only in smoke mode.
- [x] Run `node scripts/test-bench-workflow-ab.mjs`; PASS: main and QA smoke scenarios.
- [x] Run full `node scripts/bench-local-ab.mjs`; PASS: 12 measured workflow samples per version, plus previous scenarios.

### Task 3: Verification and read-only review

**Files:** Update this plan with measurements and limitations.

- [x] Run `npm test` in QA (includes TypeScript compile); observed exit 0.
- [x] Run `node --check` on both new/changed scripts and `git diff --check`; all exit 0 (Git reports unrelated LF/CRLF conversion warning).
- [x] Verify main `git status --short` matches baseline (five modified tracked files and six untracked entries) and worktree branch stays `feat/chat-native-harness`.
- [x] Manually review benchmark for measurement bias, untrusted output, temp cleanup and status claims; no subagent or commit.

## Full-workflow measurement (2026-10-28)

| Metric | Main | QA |
| --- | ---: | ---: |
| 12 measured samples after 2 warmups | 12 | 12 |
| Failing test observed | 12/12 | 12/12 |
| Correct source found from tool results | 12/12 | 12/12 |
| Passing test after repair | 12/12 | 12/12 |
| MCP calls per complete cycle | 5 | 4 |
| Median (p50) | 1479.8 ms | 786.9 ms |
| p95 | 2134.7 ms | 1011.2 ms |
| Average MCP response bytes | 7257 | 5522 |

The QA median was 46.8% lower, with 20% fewer MCP calls and 23.9% fewer response bytes. The relative gain was measured on this one deterministic scripted task under local Windows process load, not on model-selected actions. Main uses `run_command`/shell and `grep`, while QA uses `diagnose_failure`/direct argv, `task_context`, and checkpointed `edit_and_verify`/direct argv. The workflows provide the same observable repair outcome but differ in chosen commands and bundled diagnostics. No claims about model intelligence, model token consumption or production end-to-end speed are supported.

## Review and handoff

- The file path used for each patch comes from the actual search result; the script asserts that it equals the known synthetic owner. The source must be read and the broken line observed before any patch.
- Failing and passing `node:test` runs are real subprocesses, not mocked return values. Every sample resets the source to the broken state.
- All mutation targets are generated inside temporary directories, while main and QA are launched from existing compiled `dist/index.js` with sanitized environment, empty upstream config and ephemeral loopback ports. `finally` closes both MCP clients, kills any remaining child servers and removes the disposable directory.
- The benchmark intentionally fixes a known one-line bug using scripted steps. The procedure is not evidence that ChatGPT independently diagnoses, chooses a repair or uses fewer reasoning tokens.
- Repeat smoke test after formatting: exit 0. QA full `npm test`: exit 0. No external network, active tunnel, paid API, Work, commit, push or deploy.
- Final review: self-review only (user forbids subagents). This is weaker than independent review; no merge performed.