# Offline Full-Workflow A/B Design

## Intent

Evaluate whether the isolated QA MCP tool workflow saves local wall time, MCP calls and response bytes while successfully repairing an intentionally broken synthetic project. Do not claim this measures model judgment or token usage.

## Constraints

- No OpenAI API, ChatGPT Work, paid or quota-consuming model calls, tunnel, upstream, or real project data.
- Main Local Coder worktree remains read-only; run existing built `dist/index.js` only.
- Write benchmark and reports only in the already isolated QA worktree, `feat/chat-native-harness`. No commit, push, deployment or live restart.
- Both versions use the same deterministic disposable JavaScript fixture, launched through loopback MCP with sanitized environments; kill child servers and remove disposable directories even on error.

## Design choice

Reuse `scripts/bench-local-ab.mjs` and its existing two offline MCP servers instead of adding a second launcher. The scripted workflow (not a model) uses different tool combinations reflecting currently available capabilities:

- Both: start from an actually failing Node test; search for the implementation; read the returned source file; apply the exact repair; verify a passing test.
- Main: `run_command` → `grep` → `read_text_file` → `apply_patch` → `run_command` (5 calls).
- QA: `diagnose_failure` (direct argv) → `task_context` → `read_text_file` → `edit_and_verify` (direct argv) (4 calls).

The fixture includes hundreds of unrelated files, one broken function, a real Node test, and an ignored decoy. The tool result must determine which source file to edit; hard-coding an owner path after the search is not acceptable.

Emit one JSON row per version with 12 measured samples after two warmups, p50/p95 latency, average response bytes, call count, and positive counts for failing test observed, correct source chosen, and passing verification. Provide a fast `--workflow-only` smoke mode. Document that execution strategies and available tools differ, and that the scripted sequence does not prove a model would choose this path.

## Alternatives

- Run a model via paid API/Work: prohibited.
- Have user manually replay ChatGPT tasks: consumes user quota and user involvement, prohibited.
- Add a self-contained offline task replay to the existing harness: selected; no third-party calls and same process controls.