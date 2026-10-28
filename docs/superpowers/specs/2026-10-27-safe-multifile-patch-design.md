# Opt-In Safe Multi-File Patch

## Intent

One MCP call should apply a small, related batch of source edits without leaving a half-applied patch when an invalid later hunk fails. No model-side workflow engine, ChatGPT Work or hidden commands.

## Options

- Keep the existing sequential multi-file patch: minimal change, but late failures leave earlier files edited.
- Replace the legacy behavior globally: more safety but breaks existing callers relying on partial results.
- **Selected:** add `safe:true` to the existing `apply_patch` tool for multi-file patches only, using strict all-file preflight and a complete rewind checkpoint. Legacy behavior remains the default.

## Contract

Safe mode requires an explicit existing `path` base directory, 1–20 unique target paths inside that directory, and syntactically valid create/update/delete operations. It rejects existing files on create, missing files on update/delete, symlink targets and symlink ancestors. Read and calculate every update before writing anything. A failed preflight has no filesystem effects. Dry-run returns bounded diff previews and does not create a checkpoint or run hooks. Writes require an enabled, complete checkpoint. Post-edit hooks run only after all edits have been written; their failures are reported, not rolled back automatically.

On write-time failure, restore already-touched files from the in-memory originals where possible, report whether recovery was complete, and retain the rewind checkpoint. Filesystem writes across multiple paths are not truly atomic, and concurrent external modifications can prevent a clean rollback; do not label this transactionally atomic.

## Bounds and security

Maximum 20 target files and 128 KiB patch text; existing command/write permission gates remain in force. The safe mode validates target containment relative to the explicit base directory, including resolving symlink ancestors, and does not allow applying multi-file patches elsewhere. Existing `apply_patch` without `safe:true` is unchanged. No git commits, no deployment, no daemon restart.