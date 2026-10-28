# QA Retrieval Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Inline only: user forbids agents, commits, pushes and deploys.

**Goal:** Measure large-repository retrieval accurately and improve context relevance without security or quality regressions.

**Architecture:** Keep ignore-aware ripgrep and descriptor-checked reads. Move benchmark retrieval into a child process, make source snippets evidence-first, then evaluate a bounded combined-term search only if profiles justify it.

**Tech Stack:** TypeScript, Node.js, ripgrep, PowerShell, MCP Streamable HTTP.

**Spec:** `docs/superpowers/specs/2026-10-28-qa-retrieval-efficiency-design.md`

## Global Constraints

- Only `D:\\programatyvna_shlaypa(sandbox)\\chatgpt-local-coder-harness`, branch `feat/chat-native-harness`, may be edited.
- No paid API, model quotas, ChatGPT Work, subagents, live tunnel, real project data, commits, pushes or deployment.
- Preserve all pre-existing dirty state; synthetic disposable fixtures only; no weakening of ignore/symlink/secret handling.

## Review Focus

- Warm RSS of a benchmark parent that creates files is not the RSS of the retrieval algorithm; report separate worker numbers.
- Source text in comments may swamp the first three matches; preserve useful implementation evidence.
- Embedded private-key bodies can match task terms without containing a secret-looking assignment; never emit their lines.
- Multiple query terms and Unicode variants must not regress owner ranking or cause unsafe fallback when ripgrep fails.
- Scope changes to `task_context` must not break authenticated local MCP, checkpoint/edit or existing shell semantics.

## Task 1 — Honest scale measurement and profiler

**Files:** `scripts/bench-task-context-scale.mjs`, new `scripts/bench-task-context-scale-worker.mjs`.

- [x] Separate 1k/10k fixture setup from child process retrieval, retaining early/late/ignored assertions and repeated p50/p95 metrics.
- [x] Record child peak RSS and local-only baseline; inspect available small-project scan stages before trying a large-project algorithm.

## Task 2 — High-signal, private source evidence

**Files:** `scripts/test-task-context.mjs`, `src/lib/task-context.ts`.

- [x] RED: repeated comments must not displace a matching implementation line from the three returned lines.
- [x] GREEN: choose up to three bounded, distinct matching lines with useful source evidence, preserving line numbers and existing rank behavior.
- [x] RED: matched body of an embedded PEM private key must never appear in any output.
- [x] GREEN: ensure `safeLines` uses full private-key-block redaction while respecting source-size and symlink checks.
- [x] Run task-context tests, 38-query and 12-query evaluations.
- [x] RED: when matching source imports a nonmatching local helper and `maxFiles` leaves room, the missing helper must be observed.
- [x] GREEN: resolve one-hop relative JS/TS imports within the existing ignore-filtered candidate set and return bounded, securely read helper evidence; never displace an owner or exceed `maxFiles`.

## Task 3 — Profile-driven 10k optimization

**Files:** `src/lib/task-context.ts`, `scripts/test-task-context.mjs`, benchmarking scripts if needed.

- [x] Evaluate repeated per-term ripgrep calls against a bounded combined-term scan using the same synthetic files.
- [x] Add RED for four-term process budget and source owner/ignored-file correctness on >96 files; retain the existing >4k and symlink regression coverage.
- [x] Implement only a performance win that preserves real and synthetic relevance; otherwise record why the existing algorithm stays.
- [x] Rerun 10k worker latency and RSS, plus relevance and safety suites.

## Task 4 — Final acceptance and handoff

- [x] Fresh `npm test` (including authenticated local MCP HTTP E2E).
- [x] `git diff --check`, manual diff and main-tree status compared to the unchanged baseline.
- [x] Record measured gains and costs, explicit limitations, and unverified model-level intelligence.

## Execution record

- Pre-change in-process benchmark: 1k warm p50 584.6 ms, p95 639.9 ms; 10k warm p50 3673 ms, p95 5106.8 ms, RSS 186.3 MB **contaminated by fixture creation**. At 10k early and late owner found, ignored source absent. Prior run p50 ~3191 ms confirms time variability. No modifications to primary tree.
- Small 87-file scan profiling: enumeration p50 35.8 ms, four-term ripgrep p50 69.1 ms, secure local reads p50 29.7 ms; this does not itself predict 10k behavior.
- Isolated worker results (after removing fixture-creation memory): 1k p50 ~445 ms, p95 ~474 ms, sampled peak worker RSS ~59 MB; 10k p50 3679.7 ms, p95 4235.9 ms, sampled peak worker RSS 188.9 MB. The separate-process check **did not** remove the ~186 MB peak, so memory growth is attributable to retrieval/runtime rather than only fixture creation. This overturns the profiling hypothesis, and motivates a closer look at allocation retention. Early/late owner found; ignored owner absent. 20-file smoke fixture also passed.
- Task 2 snippet RED: three repeated `// resolveLedgerEntry` comments occupied the whole three-line excerpt and omitted `export function resolveLedgerEntry`. GREEN: gather bounded matching evidence, deduplicate equal text, prefer code lines and term coverage, then restore source order. `node scripts/test-task-context.mjs` 16/16 after `npm run build`; full suite in progress.
- Task 2 secret RED: querying a token inside `-----BEGIN PRIVATE KEY-----` returned the raw body in `safeLines`; GREEN: skip full private-key blocks, including encrypted-prefixed PEM headers. Updated task-context tests 17/17, real owner 38/38 Hit@3 (Hit@1 28/38), multilingual 12/12 Hit@1. The first full `npm test` after snippet selection passed; a fresh run after the PEM fix is pending.
- Task 3 isolated 10k raw ripgrep modes: four rare terms, separate scans p50 3987.5 ms versus combined union p50 3064.9 ms (four paired cycles; noisy p95). Broad `genericValue` matches 10,001 files; a blind extra union before per-term fallback would add latency. Ruling: inspect 24 evenly distributed, descriptor-safe sources and try a single grouped scan only when that sample appears sparse; if union finds <=128 candidates, securely read them and derive exact term coverage, otherwise fall back to the established per-term procedure. RED test counted **four actual ripgrep content subprocesses**, then GREEN counted **one** for a 120-file rare-term fixture while retaining the correct owner and excluding `.gitignore`. The 10k worker after this change returned its late owner in a four-term query at p50 3308.6 ms; single-term warm p50 varied around 3.2–3.7 s. Peak sampled RSS ~192.5 MB (no demonstrated RSS improvement); forced GC left ~4.6 MB live heap. Quality remained 38/38 real Hit@3 and 12/12 multilingual Hit@1.
- Task 2 direct dependency RED: a matching `calculateForecastNet` source imported `currency-helper.js`, but the `.ts` helper without query terms was omitted. GREEN: add one-hop local import evidence only into unused `maxFiles` slots, only for paths in the existing ignore-filtered enumeration, using the secure reader; never displace the chosen owner or cross the scope. An additional privacy RED found a non-query `const TOKEN = ...` leaked through initial helper evidence; GREEN now includes only function/class/type/interface declaration lines, not arbitrary initializers. Cached already checked owner content avoids an extra read on common paths. Targeted task-context 19/19, real 38/38 Hit@3, multilingual 12/12 Hit@1; multilang local p50 ~74 ms after cache refactor. Arbitrary ESM default exports, bare packages and deep transitive imports are intentionally not followed.
- Final privacy RED: an indirectly imported helper's one-line function could expose a hardcoded string in its body despite declaration-only filtering. GREEN: snippets for indirectly discovered dependencies are signature-only, cut at their body or type initializer, and hide literal values. Targeted 19/19. This is deliberately less code than an explicit source search; the owner itself retains normal bounded excerpts.
- Final verification: fresh `npm test` exit 0 (includes authenticated localhost HTTP MCP tools and tokenless denial), `git diff --check` exit 0 with one benign preexisting LF→CRLF warning, `npm run build` exit 0, task-context 19/19, real owner 38/38 Hit@3 (28/38 Hit@1, MRR 0.855), multilingual 12/12 Hit@1. Main Git status exactly matches the eleven pre-task tracked/untracked entries; QA branch `feat/chat-native-harness` remains dirty by design. No commits, API calls, model quotas, subagents, remote tunnel, push or deploy.
- Limitations: the single-term 10k path remains around 3.2–3.7 s and sampled peak RSS around 190–193 MB; the separate worker showed the memory was not merely fixture-generation overhead, but GC eventually returned its live JS heap to around 4.6–5.4 MB and RSS varies significantly. The rare multi-term gain is demonstrated on raw ripgrep scans (p50 ~3.99 to ~3.06 s) and the full new four-term retrieval at ~3.31 s, not a guaranteed 23% improvement for every task. A broad term missed by the 24-file sample may trigger a combined scan followed by the legacy scan and be slower; benchmark and report this without pretending it's solved. No actual model-level task success/quality, token use or live tunnel latency was measured under the user's restrictions. Manual author self-review, not independent subagent review.

## Follow-up — clustered search and result coverage (2026-10-28)

- [x] Add a synthetic cluster of 140 content matches that fits between the evenly spaced probes; measure its separate 1k/10k retrieval times and selected owners.
- [x] RED: the union search exceeding 128 matched source files must abort at a byte budget derived from the longest enumerated path; GREEN: use `execFile`'s bounded stdout and retain exact per-term fallback on overflow.
- [x] RED: a single rare `lateBoundaryToken` result gets buried behind 140 tied `clusteredBurstToken` files; GREEN: give bounded (24-point) document-frequency priority only to explicitly written source symbols, with no extra repository scans.
- [x] RED: unrestricted rare-word boosting regresses the 38-query top-three metric to 37/38; GREEN: avoid boosting natural-language prose and restore 38/38.
- [x] Re-run the final 10k benchmark, full `npm test`, source-owner and multilingual metrics, diff checks, and unchanged primary-worktree status; record any remaining tradeoffs.

Baseline clustered 10k p50 6485.1 ms, versus rare four-term p50 3293.1 ms in the same worker. A first bounded-union trial reduced clustered p50 to 4000.7 ms, but still buried the rare owner. Source snippets and ignore/symlink/secret protections were not weakened. No model, paid API, Work, tunnel, agent, commit, push or deploy is part of this follow-up.

Final clustered 10k p50 **4043.1 ms** in three repeats (approximately 37.7% less than initial 6485.1 ms; cross-run noise remains); rare owner present **3/3**, previously **0/3**. Normal four-term p50 3422.9 ms, 10k single-term warm p50 3507.2 ms. Peak sampled RSS ~186.2 MB, post-GC live heap ~4.7 MB: no claimed memory win. Source-owner benchmark **38/38 Hit@3, 28/38 Hit@1**, multilingual **12/12 Hit@1**, targeted task-context **21/21**, fresh full `npm test` exit 0 including authenticated local MCP HTTP and rejected tokenless request. `git diff --check` exit 0 with pre-existing LF/CRLF warning; main worktree status matches the eleven-entry baseline. Manual self-review only because subagents are prohibited. QA worktree remains dirty and uncommitted; further production-level model-effectiveness claims are not supported by these tool-only measurements.