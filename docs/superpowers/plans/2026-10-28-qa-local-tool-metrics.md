# QA Local MCP Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. This project expressly forbids subagents and commits.

**Goal:** Collect opt-in, privacy-safe local aggregate QA tool performance metrics and prepare a reversible canary.

**Architecture:** Intercept the existing McpServer.registerTool registration once; store bounded aggregates in memory. Expose them through the existing loopback admin router, under its current authentication middleware, without changing the MCP tool catalog.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Express, synthetic Node.js test scripts.

**Spec:** docs/superpowers/specs/2026-10-28-qa-local-tool-metrics-design.md

## Global Constraints

- No API, Work, model calls, deployments, tunnel changes, new service ports, commits, pushes, or main-repo edits.
- Only the existing QA linked worktree may be changed.
- Measure only safe numeric aggregates, tool name, and enabled flag. Opt-in LOCAL_CODER_METRICS=1; default off.

## Review Focus

1. An MCP tool returns HTTP success but structuredContent.ok=false: count one failed tool call.
2. A handler throws synchronously or rejects: count failure without losing the throw.
3. Large/secret-laden tool arguments and results: no content leaks through telemetry.
4. Long-running session: bounded sample memory while lifetime counts remain correct.
5. Disabled telemetry: no metrics and no payload serialization for metrics.

---

### Task 1: Aggregate module

**Files:** Create src/lib/tool-metrics.ts; test scripts/test-tool-metrics.mjs.

**Interfaces:** recordToolMetric(name, elapsedMs, resultOrUndefined, thrown?):void; isToolMetricsEnabled():boolean; getToolMetricsSnapshot(): object.

- [x] Test first: opt-in/off, success/result-level failure/throw, safe fields only, bounded history, percentile ordering.
- [x] Run tsc and test and observe expected missing-module failure.
- [x] Implement bounded in-memory aggregate, no I/O, with safe names and measurements.
- [x] Run tsc and test again; see all green.

### Task 2: Integrate registration and local admin

**Files:** Modify src/server-factory.ts and src/admin/routes.ts; extend scripts/test-tool-metrics.mjs; modify package.json test chain.

**Interfaces:** existing registerTool wrapper and GET /api/tool-metrics, protected by existing localhostOnly and adminAuth middleware.

- [x] Test first: in-memory MCP tool success/failure updates aggregate; endpoint returns only aggregate and is guarded.
- [x] Run test and observe expected failure.
- [x] Wrap registered callbacks only when opt-in is enabled; route reads pure snapshot.
- [x] Run targeted tests, then full npm test suite.

### Task 3: Safe rollout record and final verification

**Files:** Create docs/superpowers/plans/2026-10-28-qa-canary-readiness.md.

- [x] Document active tunnel identity evidence and uncertainty, opt-in/disable procedures, QA-only canary and rollback, and measurement interpretation.
- [x] Run QA checks and git diff --check. Verify main-repo Git status did not change; record no active tunnel modifications.
- [x] Explicitly report that no live A/B/model benchmark was run.