# Free Local Performance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. No external API/ChatGPT Work or paid model calls.

**Goal:** Reduce redundant local execution time and initial MCP tool catalog size without losing full/slim compatibility.

**Architecture:** Keep the existing isolated QA worktree. Skip Git status on successful command diagnosis while preserving complete error diagnostics; add an explicitly selectable focused tool profile and use it as QA's default. Verify through regression tests and the disposable main-vs-QA benchmark.

**Tech Stack:** TypeScript, Node.js, MCP Streamable HTTP, PowerShell on Windows.

**Spec:** Prior A/B benchmarks from 2026-10-28: QA edit-and-verify median 12–14% slower, tool catalog 16.5% larger, repeated context 99.2% smaller.

## Global Constraints

- No OpenAI API, ChatGPT Work, external service, or billed model calls.
- No edits, builds, commits, pushes, or restarts in the main Local Coder worktree.
- Preserve existing full/slim profiles and safe checkpoint/rollback behavior.
- Leave repository changes uncommitted.

## Review Focus

- Failed and timed-out commands must still report bounded Git status.
- Successful diagnosis must not claim Git was unavailable if it was deliberately skipped.
- Direct `git_status` remains available in focused mode.
- Essential edit/search/diagnose/rewind tools remain discoverable in focused mode.
- Explicit `slim` and `full` profiles must retain their previous behavior.

### Task 1: Remove redundant Git subprocess after successful verification

**Files:** `scripts/test-harness-operations.mjs`, `src/lib/harness-operations.ts`

**Interface:** `diagnoseFailure(options)` still returns `DiagnosisResult`; `git` explicitly reports intentional skip on clean command, while errors retain real status.

- [x] Add a regression assertion requiring `git.reason === "Skipped after successful command"` on success.
- [x] Run the targeted test and confirm the new assertion fails.
- [x] Skip `readGitState` only for success (`exit_code === 0 && !timed_out`), retain it for errors.
- [x] Run the targeted test and full suite; rerun A/B.

### Task 2: Offer a smaller focused MCP tool profile

**Files:** `scripts/test-tool-profile.mjs`, `src/lib/tool-profile.ts`, `scripts/bench-local-ab.mjs`

**Interface:** `getChatGptToolProfile()` recognizes `focused`, `slim`, and `full`; QA defaults to `focused`, and explicit `slim` stays unchanged.

- [x] Add failing tests for focused core tools, omitted rare/duplicate tools, and legacy profiles.
- [x] Run the targeted test to confirm focused is not implemented yet.
- [x] Implement the focused list and default; benchmark main `slim` versus QA `focused`.
- [x] Run the targeted test, full suite, repeated A/B and verify no leftover synthetic processes.

## Verification (2026-10-28)

- Full `npm test`: exit 0.
- Repeated isolated A/B: main edit p50 272.1/273.4 ms, QA edit p50 270.7/268.1 ms (12 warm local HTTP samples per version per run).
- Catalog: main 27 tools / 29,714 bytes, QA focused 24 tools / 27,977 bytes.
- Repeat context: main 47,670 bytes, QA 371 bytes.
- No model, external API, ChatGPT Work, active-worktree edits, commit, push, or deploy.

## Extended local A/B (2026-10-28)

The disposable `scripts/bench-local-ab.mjs` now also benchmarks 603 synthetic source/test files and one ignored decoy for each version. It uses built local MCP servers over `127.0.0.1`, isolated temporary directories, an empty upstream config and sanitized child environments. After two warm-ups, each timing is the median/p95 of 12 alternating samples. Main remains read-only.

| Scenario | Main p50 / p95 | QA p50 / p95 | Interpretation |
| --- | --- | --- | --- |
| `read_text_file` | 5.0 / 5.9 ms | 4.8 / 5.5 ms | Approximately equal; no meaningful speed claim. |
| Edit + shell verify | 268.7 / 312.4 ms (2 calls) | 271.7 / 363.7 ms (1 call) | Fewer MCP calls, but no latency win in shell mode. |
| Edit + direct argv verify | 274.2 / 306.8 ms (2 legacy shell calls) | 87.1 / 96.1 ms (1 argv call) | 68% lower median for commands eligible for direct argv execution; execution strategies differ. |
| `grep`, same synthetic files | 579.1 / 675.2 ms | 216.5 / 274.5 ms | 63% lower median for this local search workload; both locate the symbol owner. |
| `task_context`, QA only | Not available | 298.2 / 426.4 ms | Correct implementation file ranked first among 631 searched files; no equivalent main tool. |

- Repeating unchanged `project_context`: main returns 47,670 bytes again; QA returns 371 bytes (99.2% fewer bytes on repeat).
- Tool catalog: main `slim` 27 tools / 29,714 bytes; QA `focused` 25 tools / 29,968 bytes. The QA catalog is **254 bytes larger**, despite fewer tools, because it adds task-aware context.
- The ordinary `grep` tools in **both** versions include the decoy inside `.gitignore`: their default `respectIgnore=false` is intentional in the current API, so this is not an A/B regression. QA `task_context` correctly excludes that decoy.
- These figures measure **local MCP tools**, not model intelligence, model tokens, ChatGPT end-to-end latency, or task-completion quality. Results can vary by operating-system cache and process load.
- No paid OpenAI API, ChatGPT Work, real project data, external model calls, tunnel startups, commits, pushes or deployments.

### Tool-selection instructions

The A/B confirmed that the fast direct-argv edit path was only useful if the model chose it. The QA MCP agent instructions now explicitly prefer one-call `edit_and_verify` for a single-file patch with an explicit check, and `command_mode="argv"` for a known executable without shell syntax; shell mode is retained for pipelines and compound commands. The compact tool reference also names `inspect_code` and `diagnose_failure`. A new assertion in `scripts/test-project-memory.mjs` failed before this change and passed after rebuilding. This makes the fast workflow discoverable but does not establish model-level improvement without an end-to-end comparison.