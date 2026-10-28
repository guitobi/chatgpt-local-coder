# Chat-Native Harness — Compound Tool Design

## Intent

Reduce ChatGPT ↔ MCP calls for common coding investigations. ChatGPT Chat remains the only reasoning/model runtime; the local MCP server combines deterministic operations and returns bounded evidence.

## Decision and alternatives

1. **One unrestricted workflow language:** potentially fewer calls but opaque side effects, hard approvals, and difficult-to-test execution. Rejected.
2. **Focused, auditable compound tools (selected):** a small number of actions, clear MCP annotations, validation, and concise structured output.
3. **Separate autonomous model runtime:** disallowed by the user's Chat-only requirement.

## Scope

### `inspect_code` — read-only

Input: project `path`, regex `query`, optional simple file `glob`, bounded `max_matches` (default 20, max 50) and `context_lines` (default 2, max 5).

One tool call gathers:
- Git status, when the path belongs to a repository (otherwise an explicit unavailable marker).
- Line-numbered regex matches through the existing `grepSearch` path.
- Bounded source excerpts for up to five distinct matched files, read concurrently. Explicitly mark skipped large/unreadable files.

Output: root path, query, line-oriented matches, excerpts, concise Git state, truncation markers. Max model-visible source data must be bounded; no project content mutation, hidden indexing, auto-patching, or inference delegated to local software.

### `diagnose_failure` — command, not read-only

Input: explicit `command`, project `path`, bounded output character limit (default 6000, max 20000).

Reuse the existing `requireCommandAllowed`, `validatePath`, and `execInShellSession` checks and semantics, then extract file:line error locations from stdout/stderr and include Git status after the command. Return exit code, timeout status, bounded tail of both streams, identified locations, and truncation indicators. The command may change files; it must be annotated as a command and never silently retried or rolled back.

## Integration

- Register tools in `src/tools/harness.ts` via `createMcpServer` with the native `{ok,tool,summary,data}` envelope and accurate read/command annotations.
- Export narrow implementations from `src/lib/harness-operations.ts` for deterministic unit tests. Existing `grepSearch`, persistent shell, authorization, path validation and audit utilities remain authoritative.
- Add both names to the default `slim` profile. Existing MCP names/schemas remain unchanged.
- Full/raw logs remain available via existing `run_command`; this tool intentionally returns a compact diagnostic excerpt.

## Safety and non-goals

- No ChatGPT Work, OpenAI API calls, Codex app-server, separate model loop or bypass of usage limits.
- No background execution, hidden command chains, auto-escalation, auto-commit, deployment, or arbitrary "run many tools" interpreter.
- Never label `diagnose_failure` read-only. Never interpret untrusted code output as instructions.
- Do not move `apply_patch` behind a compound write tool yet: checkpoint/approval behavior must be factored and tested before an `edit_and_verify` extension.
- No changes to the live MCP instance or the dirty original `main` worktree.

## Acceptance

- TDD regression tests cover bounded excerpts, multiple files, case-sensitive code regex, colon-containing Windows paths, empty/unreadable result, Git-not-repo, output-truncation and location extraction.
- Both tool schemas are exposed in `slim` and use correct annotations.
- Full `npm test` and build pass; note any integration auth blocker without bypassing it.
- Benchmark tool result size and local execution duration without claiming host model speedups.