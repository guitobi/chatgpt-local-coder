# Local Coder QA: Security and Retrieval Acceptance Design

## Intent and constraints

Prove that the QA Local Coder can safely edit synthetic files and quickly choose relevant code context without external models. Stay in the existing `feat/chat-native-harness` worktree; no OpenAI API, ChatGPT Work, real project edits, commits, push, deploy, or active tunnel changes.

## Approaches

- **Trust the previous green tests**: rejected; they do not cover path substitution during single-file edits or broad task retrieval quality.
- **Rewrite file operations around a new transaction framework**: rejected; broad compatibility and complexity risk.
- **Narrow, test-first hardening with repeatable QA acceptance (chosen)**: reject symlink-based writes and changed file identities in the existing single-file patch path, then use a bounded fixture and local HTTP MCP to verify retrieval and safety. Improve ranking or runtime only when a reproducible test/measurement identifies an issue.

## Behavior

1. `edit_and_verify` and ordinary single-file `apply_patch` reject symlink targets and symlink parent directories, including in dry-run. After reading the original file, a changed file identity or changed original bytes aborts before any write. A valid edit keeps the same checkpoint and hooks behavior; dry-run remains write-free.
2. `task_context` never follows file symlinks; returns source-first evidence, relevant tests and scoped instructions within its size budget. Its effective ranking is checked against hand-labeled, synthetic tasks, not only whether it found *some* file.
3. The final locally authenticated HTTP MCP flow exercises the new read and edit safeguards with disposable files, together with the project's full regression suite. Benchmark reports local timing/bytes only and cannot claim model reasoning improvement.

## Acceptance and scope boundaries

- RED/GREEN test for the concrete unsafe path behavior before code fixes.
- Negative tests for symlink and modified-file targets; positive test for regular files, checkpoints, dry-run and hooks.
- Task-retrieval fixtures with expected files, accuracy and byte bounds; no real data or secrets printed.
- Full `npm test`, `git diff --check`, isolated localhost-only HTTP E2E and local A/B without model/API calls.
- Main worktree and live plugin remain untouched.