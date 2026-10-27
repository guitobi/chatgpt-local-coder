# Chat-Native Harness Performance Increment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate ordinary Local Coder code search and reduce duplicated MCP response text while preserving Chat-only architecture and tool compatibility.

**Architecture:** Keep the model loop in ChatGPT Chat. Add an optional native `rg` fast path around `grepSearch`, preserve a JS fallback, and compact only Chat-oriented tool text while retaining structured data.

**Tech Stack:** TypeScript/Node.js, MCP SDK, built-in Node test scripts, optional ripgrep executable.

**Spec:** `docs/superpowers/specs/2026-10-27-chat-native-harness-design.md`

## Global Constraints

- No Work mode, separate model calls, agent runtime, restart of the active MCP server, or push/deploy.
- No edits to the dirty original `main` worktree; all changes go to `feat/chat-native-harness`.
- Preserve existing `grepSearch` signature and `toolResult` structured envelope.
- Use a failing regression test before each behavior change and run the complete suite afterward.

## Review Focus

- Search root is a file: results have correct absolute path and line number.
- Regex unsupported by ripgrep: JS fallback still searches rather than silently losing matches.
- A directory path containing spaces or shell metacharacters: `rg` arguments cannot execute shell code.
- Unsupported or missing `rg`: no loss of search functionality.
- Non-Chat/full MCP client and error responses: structured output and legacy text stay usable.

---

### Task 1: Search fast path and compatibility

**Files:**
- Modify: `src/lib/grep-search.ts`
- Modify: `scripts/test-tools.mjs`

**Interfaces:**
- Consumes: `grepSearch(options): Promise<string>` and the existing `GrepOptions` fields.
- Produces: the same public interface, with a fast native search path and JS fallback.

- [x] **Step 1: Write failing regression tests.** In `scripts/test-tools.mjs` cover a single file, all output modes, glob exclusion, missing rg override, regex fallback, and special-character path.
- [x] **Step 2: Run `npm run build && node scripts/test-tools.mjs`.** New single-file tests failed with `No matches found` before implementation.
- [x] **Step 3: Add `rg` fast path to `grepSearch` and support file roots in the JS fallback.** Launch with `spawn`/`execFile`, never a shell; preserve no-match handling, exclusions, and bounded memory.
- [x] **Step 4: Run `npm run build && node scripts/test-tools.mjs`.** 13 tests passed.
- [x] **Step 5: Run `npm test`.** Exit 0 with all groups passing.

### Task 2: Compact Chat output, compatible with generic MCP clients

**Files:**
- Modify: `src/lib/tool-result.ts`
- Create: `scripts/test-tool-result.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `toolResult(tool, data, options)` and `toolError`.
- Produces: identical `structuredContent` in all profiles, compact `content` for `slim`, legacy JSON text for `full`.

- [x] **Step 1: Write failing `scripts/test-tool-result.mjs` tests.** Assert compact slim text, full JSON text, and error visibility; wire the script into `npm test`.
- [x] **Step 2: Run `npm run build && node scripts/test-tool-result.mjs`.** Slim assertion failed on redundant JSON text.
- [x] **Step 3: Implement profile-aware `content` formatting in `src/lib/tool-result.ts`.** Structured payload is unchanged.
- [x] **Step 4: Run the targeted test and `npm test`.** All groups passed.

### Task 3: Benchmark and handoff

**Files:**
- Create: `scripts/bench-search.mjs`
- Modify: `README.md` (a short English performance section)

**Interfaces:**
- Consumes: `grepSearch(options)` and `toolResult()` from compiled JS.
- Produces: a repeatable benchmark reporting p50/p95, result length, and compact/full text sizes.

- [x] **Step 1: Add a small self-validating benchmark fixture and expected-result assertions.** Uses a disposable OS temporary directory and cleans in `finally`.
- [x] **Step 2: Run `npm run build && node scripts/bench-search.mjs`.** 900 files: JS p50 989.8ms/p95 1284.0ms; ripgrep p50 101.5ms/p95 122.3ms; structured results match.
- [x] **Step 3: Document benchmark command and limitations, run `npm test` and `npm run build`.** Exit 0; full chat latency is not measured.
- [x] **Step 4: Inspect `git diff --check` and final worktree status.** No unrelated changes; no push or deployment.

## Verification note

The isolated `npm run test:integration` attempt failed at `GET /health` for its test admin server with HTTP 401 (`Invalid admin token`). Authorization was not bypassed or altered. Its child server exited. This suite remains unverified; normal `npm test` and search/output regression checks passed.