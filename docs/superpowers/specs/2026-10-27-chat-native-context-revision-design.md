# Conditional Chat-Native Project Context

## Intent

Ordinary ChatGPT sessions may request `project_context` repeatedly after reconnecting. Allow the caller to reuse a previously received context when the returned files are unchanged, without creating a second agent, model call, persistent indexing service, or Work-mode dependency.

## Options

- Always send all context files: backward compatible but repeats large responses.
- Cache by timestamp/size only: potentially fast but can return stale context after metadata-preserving edits.
- **Selected:** calculate a deterministic SHA-256 revision from the actual file bytes and paths on each read; respond with an empty file list when an optional caller revision matches. Existing calls still receive full files.

## Contract

`project_context` adds optional `if_revision` (64 lower-case hex chars). All responses add `revision` and `unchanged` fields. If matched, `files=[]` but `count` still states the total number of discovered readable context files. If no revision or a different revision is supplied, return all files, including their existing `truncated` flag. The hash incorporates full file bytes, even if the displayed output was truncated, so changes beyond the output cap invalidate the revision.

## Boundaries

Reuse existing path validation and context-file discovery. No durable cache files or storing project contents outside the existing response. No metadata-only invalidation, external services, shell commands, permissions change, live server restart, or changes to existing tool responses besides additive fields. Preserve existing per-file read failure semantics. This optimizes repeat response size, not initial scan latency.