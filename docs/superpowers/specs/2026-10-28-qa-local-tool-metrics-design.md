# QA-only local MCP tool metrics — design

## Intent

Determine whether the isolated ChatGPT Local Coder QA build makes tool-assisted work faster and more reliable without consuming OpenAI API, ChatGPT Work, or model quota. Keep model-quality claims separate from measured tool efficiency.

## Constraints

- QA linked worktree only; leave the main repository, existing active tunnel, and user services untouched.
- No paid API, external telemetry, cloud uploads, model calls, commits, pushes, deployments, or new tunnels.
- Existing uncommitted work must remain intact.
- Telemetry is opt-in via LOCAL_CODER_METRICS=1, disabled otherwise.
- Collect only tool names, bounded elapsed-time samples, response-byte counts, call totals, and tool-error totals. Never store arguments, response bodies, paths, prompts, session IDs, credentials, or source text in telemetry.
- Expose a read-only summary only through the existing loopback-only HTTP admin server, requiring ADMIN_TOKEN even if the rest of the admin UI runs without one. No additional MCP tool or remotely accessible endpoint.
- Retries cannot be distinguished reliably from intentional duplicate calls at this layer; report attempted calls, not a fabricated retry count.
- Test only with disposable fixtures in localhost/in-memory sessions. No runtime activation yet.

## Approaches

1. **Chosen:** wrap callbacks at the existing central tool-registration boundary and aggregate a capped history in process memory. Serve the read-only summary from the existing admin router. Small surface, no persistence or model-visible schema additions.
2. Instrument every tool handler separately. More code and higher risk of inconsistent coverage.
3. Parse existing MCP activity/audit logs. Reuses timing data but logs can contain raw arguments and does not reliably identify result-level failures.

## Design and verification

- The wrapper measures monotonic elapsed time and counts result payload bytes without saving the actual result. Result-level false/error is distinct from HTTP 200.
- Per-tool latency and size p50/p95 use a bounded sample window; lifetime counts are aggregate. The summary is inert and empty when disabled.
- Tests prove a successful and a result-level failed tool call are counted, actual source/arguments never appear in the summary, the sample history is bounded, and the admin endpoint respects loopback/auth middleware.
- QA-only runbook records exact start/rollback commands for later user-authorized canary; this phase only prepares the option.