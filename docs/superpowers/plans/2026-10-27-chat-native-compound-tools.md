# Chat-Native Compound Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two focused MCP actions that reduce coding investigation round-trips without using another model or ChatGPT Work.

**Architecture:** Pure-ish bounded local operations in `src/lib/harness-operations.ts`, thin MCP registration in `src/tools/harness.ts`; reuse existing code search, command runner, validators and audit.

**Tech Stack:** TypeScript 7, Node.js, MCP SDK, Zod, Node assertion test scripts.

**Spec:** `docs/superpowers/specs/2026-10-27-chat-native-compound-tools-design.md`

## Global Constraints

- Only ordinary ChatGPT Chat controls reasoning. No separate LLM, API, Work or external agents.
- Work only in existing isolated branch `feat/chat-native-harness`; do not restart or alter the live daemon.
- No broadened filesystem/command permissions; preserve errors, timeouts and audit trail.
- Never return unbounded files or raw command logs in compound tool output.

## Review Focus

- Very long minified match line: response remains bounded.
- Missing or non-Git directory: local search still works and Git status is explicit.
- Windows absolute path with drive colon: file/line references parse correctly.
- Failed/timed-out commands: exit code and timeout remain honest, and stderr context is preserved.
- Output that looks like a command/instruction: treated as untrusted data, not executed.

---

### Task 1: Read-only code inspection

**Files:** Create `src/lib/harness-operations.ts`, create `scripts/test-harness-operations.mjs`.

**Interfaces:** Export `inspectCode({root,query,glob,maxMatches,contextLines}): Promise<InspectionResult>`. Reuse `grepSearch` and `git status --short` without a shell.

- [ ] Write tests for multiple files, line positions, unique excerpts, long lines, zero matches, and Git-less paths.
- [ ] Build and run targeted test; observe RED because `inspectCode` is absent.
- [ ] Implement bounded inspection with read-only operations and meaningful truncation flags.
- [ ] Targeted test and `npm test` GREEN.

### Task 2: Command failure diagnosis

**Files:** Modify `src/lib/harness-operations.ts`, modify `scripts/test-harness-operations.mjs`.

**Interfaces:** Export `diagnoseFailure({command,root,maxOutputChars,timeoutMs}): Promise<DiagnosisResult>`. Reuse `requireCommandAllowed`, `execInShellSession` and Git status.

- [ ] Write tests for a safe successful command, nonzero failure, file:line extraction, and bounded log tails.
- [ ] Run targeted test; observe RED because `diagnoseFailure` is absent.
- [ ] Implement with existing shell execution rather than a new command permission path.
- [ ] Targeted test and `npm test` GREEN.

### Task 3: Register MCP tools and document

**Files:** Create `src/tools/harness.ts`, modify `src/server-factory.ts`, modify `src/lib/tool-profile.ts`, modify `scripts/test-tool-profile.mjs`, modify `package.json`, modify `README.md`.

**Interfaces:** Register native tools `inspect_code`, `diagnose_failure` with Zod input schemas, correct annotations, `toolResult`, and audit. Expose both in slim/full.

- [ ] Write failing tool registration/profile tests (slim exposure and safety hints).
- [ ] Run tests RED.
- [ ] Wire tools, validation, bounded schemas and audit; add focused test to the main suite.
- [ ] Run build, targeted tests, `npm test`, and `git diff --check` GREEN.
- [ ] Record unresolved integration issues and local-only results. No push or deploy.