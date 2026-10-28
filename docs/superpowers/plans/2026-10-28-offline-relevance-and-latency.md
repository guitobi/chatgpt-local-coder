# Offline Retrieval and Edit Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Inline execution only; no subagents or commits.

**Goal:** Make QA retrieval measurably more useful across diverse tasks and determine the actual edit latency bottleneck without paid calls.

**Architecture:** Extend the existing local owner benchmark, write failing morphology fixtures, apply the smallest lexical fix, measure isolated edit phases, and verify the complete MCP path.

**Tech Stack:** TypeScript, Node.js, ripgrep, MCP Streamable HTTP, PowerShell.

**Spec:** `docs/superpowers/specs/2026-10-28-offline-relevance-and-latency-design.md`

## Global Constraints

- No API, ChatGPT Work, model/subagent calls, production data, tunnel, main-worktree edits, commit, push, or deploy.
- Regression tests must run on disposable data. Reject any relevance changes that increase leakage or cause material latency regression.

## Review Focus

- Morphological expansions must remain bounded and treat one user term as one matching term, even if several forms occur.
- Hidden, ignored, sensitive and symlinked sources must remain excluded.
- Benchmark cases must be labeled independently of search output.
- Large files and long output must remain bounded.
- A shell latency shortcut cannot silently change command semantics or security rules.

### Task 1: Broaden retrieval evaluation

- [x] Extend hand-labeled real repository queries beyond six; record Hit@1/3/6 and p50/p95.
- [x] Add cross-language synthetic cases for code, tests and decoys.
- [x] Record baseline and follow-up results separately.

### Task 2: Fix confirmed lexical misses

- [x] Add RED tests for plural names and common verb inflections.
- [x] Implement bounded variants in filename/content evidence.
- [x] Run regression GREEN and remeasure the real owner benchmark.

### Task 3: Edit latency, quality gate, and review

- [x] Run disposable local phase timings, distinguish PowerShell startup from patch/checkpoint overhead.
- [x] Optimize only if a safe measurable bottleneck is confirmed; otherwise report the architectural limit.
- [x] Run full `npm test`, localhost E2E, `git diff --check`, and verify unchanged main worktree.
- [x] Perform read-only security/self review; disclose that independent agent review was excluded by cost limits.

## Observed offline evidence (2026-10-28)

- The original 38-case hand-labeled real-repository benchmark recorded Hit@1 21/38, Hit@3 28/38, Hit@6 31/38, MRR 0.657. On those **same original labels**, the morphology change improved Hit@3 to 32/38 and Hit@6 to 34/38; this is the directly comparable quality measurement.
- Review found two invalid label formulations and several tasks with multiple valid code owners. After correcting the gold definitions, the separate final 38-case evaluation recorded Hit@1 25/38, Hit@3 37/38, Hit@6 37/38, MRR 0.803. Do not compare these corrected-label totals directly with the initial totals.
- Synthetic cross-language benchmark covers 12 separate TypeScript/Python/Go cases, 12/12 Hit@1. Synthetic fixtures are not a proxy for real model performance.
- Edit phase benchmark (warm local medians): patch/checkpoint 13 ms; PowerShell verification 253 ms; equivalent direct Node verification 70 ms; combined 272.5 ms. Arbitrary shell verification still uses PowerShell, avoiding command-semantic changes.
- Scan profiling on 86 ignore-filtered source files: enumeration p50 43.5 ms, separate ripgrep term processes p50 94.7 ms, full bounded/symlink-safe file scan p50 34.9 ms. Added a 96-file-bounded safe local content scan for small ASCII queries with ripgrep fallback for larger sets and Unicode; original ignore-aware enumeration and fail-closed behavior are retained.
- Post-change target tests: 14/14, including a large-repository fallback, Unicode, nested ignore, symlink/credential exclusion. Benchmark after the fast path: 37/38 Hit@3 on corrected labels. Search wall times vary between runs and workloads; do not claim a model-level speedup.
- Two final 12-sample warm real-repo benchmarks after the fast path measured `task_context` p50 116.4 / 155.9 ms and p95 155.6 / 372.5 ms on 86 candidates. Cross-language synthetic recheck retained 12/12 Hit@1 with p50 103.8 ms, p95 705.2 ms. The variable tails prevent a stable speedup claim. These are local process benchmarks, not controlled A/B inference or model task completion.
- `npm test` finished exit 0, including authenticated localhost HTTP MCP transport, and `git diff --check` exited 0 (one LF/CRLF Git warning, no diff error). Main worktree status was compared entry-for-entry with the initial baseline and remained unchanged.
- Self-review: the small-file strategy only consumes paths enumerated by ignore-aware ripgrep and calls the existing symlink/realpath/bounded open helper; Unicode and larger repositories retain the old search route. Shell command execution semantics and permission model were deliberately not changed. Independent review with additional agents was not permitted by the user.