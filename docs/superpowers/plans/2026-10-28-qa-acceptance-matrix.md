# Offline QA acceptance: ten end-to-end MCP scenarios

## Goal and safety boundary

Establish correctness and recovery gates for the isolated `feat/chat-native-harness` QA worktree before considering any activation. Run actual MCP calls against a disposable localhost server and synthetic source files; do not call any model, OpenAI API, remote tunnel, upstream connector, ChatGPT Work, or real user repository.

The main Local Coder repository is read-only. Do not commit, push, merge, deploy, or alter live MCP configuration.

## Automated acceptance scenarios

Run `npm run test:qa:acceptance` in the QA worktree. The runner creates temporary fixture directories, starts one isolated HTTP MCP server with an empty upstream configuration and sanitized environment, then cleans up in a `finally` block.

1. Reproduce a failing Node test, find its source with `task_context`, apply a single-file fix and pass verification.
2. Discover a direct CommonJS dependency, preview a safe two-file patch, commit atomically, and pass verification.
3. Rank the active source over a duplicate symbol in an archive.
4. Include the real implementation line despite repeated misleading comments.
5. Locate a rare symbol among 320 synthetic source files while respecting a bounded response.
6. Hide ignored paths, generated files, credential paths, and synthetic secret values from source search.
7. Report a failing command with machine-readable file, line, and exit code.
8. Report an actual local TypeScript compiler error with machine-readable location.
9. Reject a stale second hunk without modifying either file of a two-file transaction.
10. Preserve a checkpoint on failed verification and restore the original file through `rewind`.

## Regression coverage

- `scripts/test-task-context.mjs` includes the CommonJS `require()` regression and checks that indirect dependency snippets do not reveal initializer values.
- `npm test` invokes the ten-scenario acceptance runner alongside the existing regression suites.
- `scripts/bench-local-ab.mjs` provides an offline main-versus-QA scripted A/B benchmark; it does not measure independent model reasoning.

## Completion gates

- All 10/10 scenarios pass through real local HTTP MCP transport.
- Full QA `npm test`, syntax check and `git diff --check` pass.
- Baseline main repository stays unchanged.
- No claim of improved model intelligence or production reliability without a separate authorized model-level test.

## Verified outcome (2026-10-28)

- `node scripts/test-qa-acceptance.mjs`: **10/10 PASS**, including real Node and local TypeScript failures, safe multi-file rejection and rewind.
- `npm test`: exit 0, including the new acceptance suite.
- `node --check scripts/test-qa-acceptance.mjs` and `git diff --check`: exit 0.
- `node scripts/bench-local-ab.mjs`: exit 0, 12 measured runs per version for scripted full workflow.
  - Main: 5 calls, p50 1464 ms, p95 1694.1 ms, 7257 response bytes.
  - QA: 4 calls, p50 800.3 ms, p95 902.4 ms, 5522 response bytes.
  - QA p50 is 45.3% lower, with 20% fewer MCP calls and 23.9% less serialized response data.
  - A direct-argv edit path is materially faster; a shell-only edit is **not** faster than main on this run.
- The earlier QA `grep` behavior (ignored decoy included by default) was subsequently hardened in the isolated QA worktree. As of the follow-up hardening run, QA excludes the ignored decoy by default while main continues to include it. An explicit `respect_ignore:false` preserves the old broad-search behavior.
- Main repository Git state matches the pre-test baseline. No main source was written.

These are deterministic local transport and scripted-tool results, not a blind coding-assistant A/B study. Temporary fixture cleanup was handled by the runner.