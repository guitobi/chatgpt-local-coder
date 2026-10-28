# Task-Aware Repository Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. No subagents, external API or ChatGPT Work are authorized.

**Goal:** Add safe, low-overhead, task-aware source discovery to QA Local Coder.

**Architecture:** Extract bounded lexical retrieval into `src/lib/task-context.ts`; expose it as `task_context` in `src/tools/context.ts`; add it to the focused profile, guide agents in the prompt, and verify via tests and isolated HTTP MCP.

**Tech Stack:** Node.js 24, TypeScript, ripgrep, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-10-28-task-aware-context-design.md`

## Global Constraints

- No API keys, billed models, ChatGPT Work, external network, main worktree writes, commits, push or deploy.
- Read-only operation. No follow-symlink traversal or `.env`/secret file contents.
- Result budget and deterministic evidence; preserve existing tools and profiles.

## Review Focus

- Filenames with regex metacharacters and Windows drive letters are handled literally.
- Content matches outside filename terms can still surface relevant files.
- Ignored, hidden, dependency, symlink, and sensitive files are never included.
- Oversized source files and minified lines do not enlarge responses past budget.
- Failure or absence of `rg` is explicit, not silently fabricated as an empty repository.

### Task 1: Lexical task context

**Files:** Create `scripts/test-task-context.mjs` and `src/lib/task-context.ts`.

**Interfaces:** `buildTaskContext({root:string,task:string,maxFiles?:number,maxChars?:number}):Promise<TaskContextResult>`.

- [ ] Write tests for path/content relevance, neighboring tests, ignored/sensitive/symlink exclusion, deterministic bounds and `rg` absence.
- [ ] Run the tests against missing code, record expected RED.
- [ ] Implement bounded retrieval and explicit warnings; avoid reading forbidden files.
- [ ] Run targeted tests and full suite.

### Task 2: MCP integration and agent guidance

**Files:** Modify `src/tools/context.ts`, `src/lib/tool-profile.ts`, `src/lib/codex-agent-prompt.ts`, `scripts/test-harness-registration.mjs`, `scripts/test-tool-profile.mjs`, `scripts/test-chat-harness-http.mjs`, `package.json`.

**Interfaces:** `task_context` read-only MCP tool with task/path/limits, exposed by focused/slim/full profiles.

- [ ] Write failing MCP/profile E2E assertions.
- [ ] Register the tool, wire focused discovery and on-demand prompt guidance.
- [ ] Run targeted MCP tests, full `npm test`, HTTP E2E and isolated benchmark.
- [ ] Check worktree diff, cleanup and main worktree unchanged.