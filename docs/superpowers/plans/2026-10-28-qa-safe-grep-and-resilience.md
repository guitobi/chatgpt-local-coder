# QA safe grep and resilience: offline follow-up

## Boundaries

Isolated QA worktree only. No main-repository writes, API/model calls, ChatGPT Work, external tunnel, commit, push or deployment. All testing uses synthetic files and disposable localhost MCP server processes.

## Changes

1. `grep` defaults to ignore-aware search; `respect_ignore:false` explicitly restores broad legacy behavior.
2. The safe path obtains file candidates from ignore-aware ripgrep and applies the same safety rules to content, file names, counts, context windows and multiline searches. Sensitive filenames and source lines (including private-key blocks) are omitted.
3. If ripgrep is unavailable, safe grep fails closed instead of scanning ignored paths. File-level safe reads currently skip matches in files over 4 MiB; this limitation is intentional and must not be described as full-repository search completeness.
4. Repeated checks of parent-directory identity after asynchronous reads prevent the tested junction-swap from redirecting safe multi-file patches outside the target tree.
5. Rollback of newly-created files additionally checks an opened file handle's identity and contents. This prevents the deterministic replacement-file deletion demonstrated by the regression fixture even when path metadata collides.

## Evidence (2026-10-28)

- `node scripts/test-tools.mjs`: 15/15 PASS, including safe grep default, context, multiline, explicit opt-out and missing-ripgrep fail-closed.
- `node scripts/test-safe-multi-file-patch.mjs`: 15/15 PASS after a RED regression demonstrating deletion of a replacement file when inode metadata was indistinguishable.
- `node scripts/test-chat-harness-http.mjs`: PASS, covering authenticated grep, eight concurrent edit races, timed-out verification with `rewind`, symlink rejection and restart into a fresh authorized session.
- Full `npm test`: exit 0 including 10/10 acceptance scenarios.
- `node scripts/bench-local-ab.mjs`: exit 0, 12 measured samples per version:
  - Main full workflow: 5 MCP calls, p50 1362.1 ms, p95 1625.4 ms, 7256 response bytes.
  - QA full workflow: 4 MCP calls, p50 747.8 ms, p95 814.4 ms, 5522 response bytes.
  - QA scripted p50 improved 45.1%; response bytes reduced 23.9%.
  - Main `grep` p50 635.7 ms and includes ignored decoy; QA safe `grep` p50 242.5 ms and excludes ignored decoy.

## Residual limits

- These are scripted tool-level tests, not evidence of better independent model reasoning or total ChatGPT response latency.
- Changing the default `grep` behavior is deliberate. Users who explicitly need ignored files must pass `respect_ignore:false`, which bypasses the protection.
- File operations on Windows cannot fully eliminate adversarial path-swap races using ordinary path-based Node filesystem calls. The tested swaps are detected, and incomplete rollback is reported. This is not a guarantee against every possible concurrent attacker.
- A live tunnel, deployment and model-level A/B remain untested and outside authorization.