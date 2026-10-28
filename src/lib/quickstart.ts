export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
2. Call project_context(path) only for a different repo than WORKSPACE_PATH.
3. For unfamiliar multi-file tasks, call task_context(task, path) to locate likely code, tests and scoped instructions; inspect_code or glob/grep/read_text_file for follow-up searches.
4. For one file plus a test, use edit_and_verify. For several files, use apply_patch with safe:true and a base directory; review dry_run first when uncertain.
5. Run standalone builds/tests with diagnose_failure (bounded diagnostics), run_command (full output) or start_process + process_output (long).
6. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- glob / grep / read_text_file: explore (offset+limit for partial reads)
- task_context: bounded task-aware source, tests and scoped instruction discovery
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- create_directory / delete_directory / copy_file / move_file / delete_file
- run_command: persistent shell (cd persists); shell_status / shell_reset
- git_status / git_diff / git_add / git_commit / git_branch / git_restore / git_stash
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- enabled upstream MCP tools are exposed directly as <server>__<tool> (for example chrome-devtools__list_pages, linear__get_user); prefer direct tools
- mcp_servers / mcp_tools / mcp_call — upstream diagnostics/fallback when a direct proxy is unavailable
- git_push / git_checkout / delete_directory: may be blocked by ChatGPT safety — use run_command fallback

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Full machine access — use ANY absolute path (C:\\, D:\\, etc.). Relative paths resolve from default cwd.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  _fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    "Full machine access: ON. Tag this connector in ChatGPT before every task.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load CLAUDE.md from another repo",
    "task_context(task, path) — find source, tests and relevant instructions for an unfamiliar task",
    "inspect_code(query) — combined bounded search and Git evidence",
    "edit_and_verify — one-file patch, checkpoint and explicit test in one call",
    "apply_patch(path, safe:true) — preflighted multi-file patches",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}