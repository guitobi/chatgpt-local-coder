# QA Retrieval Efficiency and Evidence Design

## Intent

Make the isolated Local Coder QA tool return more useful source evidence with lower measured latency and memory on large projects. Do not confuse retrieval benchmarks with model intelligence.

## Existing behavior

`task_context` enumerates ignore-filtered code paths, then chooses in-memory secure reads for up to 96 candidates or one `rg --files-with-matches` process per query term for larger projects. Up to 4,000 ranked candidates are retained, while unique matches after that boundary are recovered. It emits up to three matching lines per file. The benchmark creates 10,000 files in the same process whose RSS it attributes to retrieval, so its memory measurement includes fixture creation.

## Approaches

1. **Recommended: measured, bounded improvements.** Separate fixture setup from worker RSS measurement; preserve the existing safe file reader and ignored-path rules. Improve the three-line evidence selection to prefer useful code over repeated comments, fill spare context slots with verified direct local import evidence, and trial a bounded single ripgrep union for multi-term searches only if controlled comparisons demonstrate a gain without ranking regressions.
2. **Persistent repository index.** Speeds repeated queries but requires complete invalidation for source, symlink and `.gitignore` changes; rejected for this QA phase because stale permissions/results would be unacceptable.
3. **Read every source locally.** Removes external grep startup but scales unsafe I/O and latency to 10,000 full file opens; rejected unless profiling unexpectedly establishes it is cheaper.

## Constraints

- Modify only the existing linked `feat/chat-native-harness` QA worktree. Keep all preexisting dirty changes; do not commit, push, deploy, modify the primary tree or call a model.
- No paid API, ChatGPT Work, user quota, subagents, tunnel, network or real user data. Synthetic disposable test fixtures only.
- Never trade correctness, ignore handling, symlink protection, secret redaction, deterministic ranking or `maxChars` for speed.
- Preserve the result schema and existing `task_context` tool contract.

## Success criteria

- A separate Node worker measures retrieval RSS independent of fixture generation; latency includes retrieval calls, not setup.
- Source evidence includes an implementation line even if repeated comments occupy the first three keyword hits; never exposes an embedded multiline private key. When a source owner leaves room within `maxFiles`, include bounded source evidence for a direct ignore-safe local import, not external packages or ignored files.
- 38 real owner queries maintain Hit@3 38/38, 12 multilingual synthetic owner queries maintain Hit@1 12/12; large late owner and ignored-source probes pass.
- Any adaptive search optimization has synthetic RED tests before code and demonstrable same-fixture speed benefit; otherwise do not ship it.
- Full `npm test`, authenticated local MCP E2E and `git diff --check` pass. Report measured limitations and lack of model-level validation.