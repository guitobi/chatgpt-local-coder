# Conditional Project Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid repeating unchanged project context in ChatGPT Chat tool responses.

**Architecture:** Extend the existing `project_context` MCP handler with a deterministic content revision and an optional conditional response. Keep all reads and path validation in the existing handler, use SHA-256 over the actual bytes.

**Tech Stack:** TypeScript, Node.js crypto, MCP SDK, Zod, existing real HTTP test fixture.

**Spec:** `docs/superpowers/specs/2026-10-27-chat-native-context-revision-design.md`

## Global Constraints

- Ordinary ChatGPT Chat only. Do not use Work mode, a model API, or external agents.
- Isolated worktree only; no live daemon, credentials, deployments or Git push.
- Current `project_context` calls must continue returning all files.

## Review Focus

- A file changes while retaining size; a new revision must be produced.
- Only bytes past `max_bytes_per_file` change; revision must still invalidate.
- File enumeration order differs; revision must remain deterministic.
- Missing/unreadable file no longer contributes to revision.
- Invalid `if_revision` is rejected by the schema.

### Task 1: Conditional context response

**Files:** Modify `src/tools/context.ts` and `scripts/test-chat-harness-http.mjs`.

**Interfaces:** `project_context({path?,max_depth?,max_bytes_per_file?,if_revision?})` -> `{root,files,count,revision,unchanged}`.

- [ ] Write authenticated HTTP tests: first response includes a revision; equal revision omits files; changed same-size context invalidates; truncated-file tail change invalidates; malformed revision is rejected.
- [ ] Run `npm run test:harness:http` and observe RED.
- [ ] Add deterministic full-byte hashing of sorted files to the existing handler and conditional response logic.
- [ ] Run targeted test and full `npm test` and `npm run build` GREEN.
- [ ] Measure JSON response bytes before and after a conditional request. No commit or deployment.