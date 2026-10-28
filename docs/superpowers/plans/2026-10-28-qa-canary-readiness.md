# ChatGPT Local Coder QA — local telemetry and canary readiness (2026-10-28)

## Current disposition

**QA code is a candidate, not an active rollout.** No running connector, tunnel, environment variable, port, upstream, or user service was changed during this phase. No OpenAI API, ChatGPT Work, model evaluation, commits, or pushes.

## Read-only runtime evidence collected

- QA is an existing linked Git worktree on feat/chat-native-harness, separate from the main checkout.
- The existing tunnel-client process is visible, but its observed process arguments do **not** reference the QA worktree. Its connection target and currently served build are **not proven**.
- Local TCP port 3000 is listened on by com.docker.backend.exe; GET http://127.0.0.1:3000/health returns HTML, not the Local Coder JSON health contract. Do **not** assume port 3000 runs QA.
- Local TCP port 3001 is listened on by a node.exe process whose sanitized process arguments point to the main checkout, not QA; admin health did not yield an authorized JSON response.
- Ports 3100 and 3101 were not listening when checked. This is a point-in-time observation, not a reservation.
- Never infer that ChatGPT has switched to QA merely because the QA source or dist directory is up to date.

## Opt-in telemetry interface

- Off by default. To enable in a **new, later-authorized QA-only process**, set LOCAL_CODER_METRICS=1 **before server startup**.
- Exposes a read-only GET /api/tool-metrics under the existing loopback admin server and its existing ADMIN_TOKEN check. Unlike other admin routes, this route fails closed with HTTP 503 when ADMIN_TOKEN is unset, so a freshly configured admin token is mandatory.
- Fields: enabled; tools[] with name, calls, errors, sample_count, latency_ms p50/p95, response_bytes p50/p95.
- Timing is callback execution time, excluding network/tunnel latency and any later serialization. Bytes are the UTF-8 length of the serialized tool result measured before transport framing. Thus these are tool-side measurements, not end-to-end user latency.
- Each tool stores at most 256 timing/size samples. Counts continue for the process lifetime. No metrics file is written automatically, and restarting discards the aggregates.
- There are no args, command strings, file paths, source contents, prompts, session IDs, credentials, or response bodies in the summary. The pre-existing **activity and audit logs are separate** and may contain argument text; telemetry does not change their behavior. Do not confuse their privacy properties.
- Repeated calls are counted, but retries are not distinguishable reliably from intentional duplicate requests.
- This adds no MCP tool, no ChatGPT tool-description tokens, and no external metrics dependencies. With LOCAL_CODER_METRICS unset, callbacks are registered without the telemetry wrapper.

## Canary procedure — NOT authorized/executed yet

1. Confirm QA Git branch, diff, disposable test fixtures, and expected model-free benchmark baseline. Verify all intended QA-only changes. Never modify main Git files or its active process.
2. Identify the active tunnel **target build and configuration** with authorized local diagnostics. Do not assume that a healthy tunnel is using the QA binary. Until identity is verified, do not update ChatGPT connector or tunnel routes.
3. Confirm ports 3100 and 3101 are free immediately before starting a **separate** QA process. Choose different ports if they are occupied. No changes to ports 3000/3001.
4. In a dedicated new PowerShell terminal, configure an isolated test-only working directory, loopback HOST, explicit PORT=3100 and ADMIN_PORT=3101, LOCAL_CODER_METRICS=1, and a freshly generated ADMIN_TOKEN. Check that the QA process does not load real upstream MCP endpoints or real business data. Avoid putting any API key into source or persisted configuration.
5. Only after separate approval, start the QA process from this worktree with node dist/index.js. Verify its local /health identifies the expected workspace, ports, and process, then use synthetic fixture MCP calls. This phase does not tunnel or connect ChatGPT to that new process.
6. Query the admin metrics endpoint from the same machine with its bearer token. Export only the resulting aggregate JSON to a local QA-only report if needed. Do not publish it or combine it with audit logs.
7. Compare identical synthetic scenarios with instrumentation off/on to measure observer overhead. Compare main and QA in matching conditions, using separate isolated test instances and 10+ samples; report p50/p95, result bytes, errors, and call count. Analyze correctness alongside latency.
8. **Rollback:** stop only the newly started QA process via its terminal (Ctrl+C). Do not touch the existing main/tunnel processes. Remove the transient QA-only environment variables in that terminal. If a connector was later pointed to QA after separate authorization, restore the previous connector setting and verify its health.

## Verification gates for deciding whether QA is better

- Correctness: same deterministic fixture outcomes and error semantics; no missing tools or regressions.
- Efficiency: fewer MCP tool calls, lower serialized payload, and lower p50/p95 latency under identical synthetic tasks.
- Reliability: zero unexpected failures and successful session recovery in isolated tests.
- Security: no sensitive bytes in telemetry summaries and no wider network bind than loopback.
- Model quality: **unmeasured**. Without user-authorized model sessions, neither improved model reasoning nor actual ChatGPT time-to-solution can be claimed.

## Offline verification at this checkpoint

- npm test returned exit 0, including the opt-in telemetry test, protected admin route, and the 10/10 QA acceptance cases.
- node scripts/bench-local-ab.mjs returned exit 0; both versions completed 12/12 synthetic full-workflow cases correctly.
- Full workflow: main 5 MCP calls, p50 1241.7 ms, p95 1378.3 ms, average response bytes 7253; QA 4 MCP calls, p50 680.6 ms, p95 746.3 ms, average response bytes 5521. QA p50 is 45.2% lower for this fixture.
- Search: main p50 532.2 ms, p95 548.1 ms; QA p50 217 ms, p95 236.2 ms, same synthetic search fixture.
- Simple file read: main p50 4.4 ms and QA p50 4.6 ms, so there is no demonstrated single-file-read speedup.
- The benchmark uses isolated ephemeral loopback-only MCP servers and synthetic inputs, no tunnel, API, Work, or model. Telemetry was **disabled** during the performance comparison, as in default QA configuration.

## Additional isolated telemetry comparison (2026-10-28)

- Added an opt-in `--qa-metrics-on` flag to `scripts/bench-local-ab.mjs`. Only the disposable QA child receives `LOCAL_CODER_METRICS=1` and a random, process-local `ADMIN_TOKEN`. The main benchmark child remains uninstrumented. Neither uses a live tunnel, API credentials, Work, or actual workspace data.
- The benchmark queries the read-only loopback admin route and validates that the metrics snapshot contains only aggregate tool names/counts/errors/latencies/bytes. It reports no bearer token or input text.
- New regression coverage in `scripts/test-bench-workflow-ab.mjs` witnessed the expected RED failure before implementation and passed afterward. The QA telemetry run recorded exactly four tool types, 16 total callbacks, including four reads and four expected failing-test outcomes, all while the functional workflow continued to pass.
- Two separate pairs of short workflow-only runs (three measured samples per child, after one warmup) produced:

  | Pair | QA without telemetry p50 | QA with telemetry p50 | Main reference p50 off/on |
  | --- | ---: | ---: | ---: |
  | 1 | 775.2 ms | 785.8 ms | 1388.0 / 1361.1 ms |
  | 2 | 820.6 ms | 740.7 ms | 1453.4 / 1360.2 ms |

- The sign of the telemetry delta reversed between runs while main reference timing also drifted. **No statistically defensible overhead estimate** can be inferred from these short samples. There is no evidence of large overhead in these runs. The earlier 12-sample performance comparison remains the stronger offline A/B baseline.
- A subsequent full run (12 measured workflow samples per version, 2 warmups) with the optional metrics flag showed QA p50 711.7 ms / p95 742.5 ms and main p50 1294.1 ms / p95 1361.5 ms. The aggregate snapshot contained 6 expected tool types, 128 total calls and 14 intentional failing-test outcomes; no project path or admin token.
- A comparable full run without metrics showed QA p50 729.6 ms / p95 752.2 ms and main p50 1314.9 ms / p95 1502.5 ms. All 12/12 workflow corrections passed in both runs. These are sequential runs, so the small QA timing difference is not evidence that metrics improve performance; host drift dominates.
- The first full telemetry run exposed a benchmark assertion that wrongly required workflow-only tool names. Fixed the assertion for both full and shortened modes; full metrics-on benchmark and workflow-only regression test then passed with exit code 0. The benchmark's privacy assertion now verifies the exact synthetic project path and ephemeral admin token are absent.
- The full `npm test` chain was rerun successfully, including 10/10 synthetic QA acceptance cases. `git diff --check` returned exit code 0 (one pre-existing line-ending warning). No active service, tunnel, or connector was switched.
- This is **not** a real ChatGPT/model-quality comparison. Confirming an actual connector routes to QA and evaluating end-to-end reasoning still require a separate authorized live canary.

## Pending gate

The critical unknown is the actual running tunnel target. Live QA canary activation, connector changes, and human/model A/B evaluation are all intentionally deferred.