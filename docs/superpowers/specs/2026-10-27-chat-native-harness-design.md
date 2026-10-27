# Chat-Native Coding Harness — First Performance Increment

## Intent

Reduce ChatGPT Chat coding latency, MCP round-trips, and model-visible output size while keeping ChatGPT Chat as the only language-model controller. The Local Coder MCP process is a deterministic tool executor, not a second agent or model loop.

## Goals

- Keep existing tool names, schemas, and supported MCP clients working.
- Make ordinary code search fast on large directories, without requiring an index, database, daemon restart, or a new runtime.
- Keep native tool results structured while avoiding a redundant full JSON text copy in the Chat-oriented `slim` profile.
- Establish repeatable, local measurements of search latency and response sizes.
- Preserve current behavior when the acceleration tool is unavailable or unsuitable.

## Constraints and non-goals

- Do not use ChatGPT Work, Codex app-server, OpenAI API calls, external agents, or extra model subscriptions.
- No silent writes to user project files from read-only search or benchmarking.
- No server/tunnel restarts, production deployment, or changes to the original dirty `main` worktree in this increment.
- Never bypass permissions or confirmation requirements to make MCP actions faster.
- Do not add vector search or persistent indexing without benchmark evidence.
- Do not pretend the MCP server can control ChatGPT's reasoning loop or bypass Chat plan limits.

## Approaches considered

1. **Optimize the existing JS traversal only:** easiest compatibility, limited speed improvement on large repositories.
2. **Use ripgrep with an exact-behavior fallback (selected):** fast common path; retain the JS scanner for multiline/context/unsupported cases and environments without ripgrep.
3. **Introduce a separate agent runtime or semantic database:** violates Chat-only constraints or adds unnecessary setup and maintenance.

## Design

`grepSearch(options)` remains the public API. For ordinary search modes with no context or multiline regex, prefer a subprocess `rg` invocation with argument arrays (no shell) and bounded output. Support both directory and single-file targets. Preserve the public string response formats and return `No matches found` for an empty search. When `rg` is absent, reports an unsupported regex, or cannot serve the requested mode reliably, fall back to the existing JS scanner. Avoid crossing symlink boundaries and preserve directory exclusions. Any compatibility difference found in tests is a reason to narrow the fast path.

`toolResult()` keeps `structuredContent` unchanged. In Chat-oriented `slim` mode, the `content` text becomes a short status/summary rather than an identical pretty-printed JSON object; full mode keeps the old JSON text for compatibility. Failure status and message remain visible in both modes. This reduces duplicated data without discarding structured results.

Add local repeatable benchmark commands to measure median/p95 search time on a controlled tree and the byte size of an MCP result in each profile. Benchmarks must not assert invented speedup targets; compare before and after data on the same machine.

## Verification

- Tests cover file-path search, directory search, glob filtering, no match, context/multiline fallback, missing `rg`, and output modes.
- Tests prove `slim` compact and `full` legacy output semantics, including errors.
- TypeScript build and full `npm test` succeed in the isolated worktree.
- The baseline measurements and changed measurements are recorded. No claim of faster end-to-end ChatGPT execution without a comparable live Chat benchmark.

## Later increments

Once measurements justify them: focused compound MCP actions for inspect/diagnose/verify, git-aware context retrieval and cache invalidation, and resumable task snapshots. Each gets a separate design and regression tests; the server must never make unapproved architectural choices or Git/deploy decisions.