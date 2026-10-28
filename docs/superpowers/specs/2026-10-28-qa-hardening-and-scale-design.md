# QA Retrieval, Scale, Shell and MCP Hardening Design

## Intent

Improve the QA Local Coder's task-to-code ownership and responsiveness, and verify that the gains survive larger repositories. Preserve the existing secure local-only test surface and the primary worktree.

## Scope and choices

1. **Owner ambiguity:** distinguish tool registration/implementation from catalogs merely listing tool names. Use a bounded source-definition signal, not per-query hand-coded file names. Keep the 38-query evaluation and add focused competing-catalog regression cases before changing ranking. A vague task may remain unresolved if an honest signal is absent.
2. **Large repositories:** create disposable fixtures with 1,000 and 10,000 small source files, ignored and hidden paths, source near the beginning/end of enumeration; record hit-rate, truncation, peak memory and latency. A 4,000-candidate scan cap currently makes far-end results vulnerable; only change code with a failing contract test.
3. **Shell speed:** preserve command strings and their PowerShell semantics. Measure current launcher overhead and examine an explicitly opt-in argv-verification path only if its authorization, working directory, timeout, log cap, and failure contract can be tested independently. No implicit parsing/special-casing of shell strings.
4. **Security and integration:** review all changed file boundaries for ignored-file leaks, symlink traversal, path races, timeout descendants, logging of sensitive text, and checkpoint guarantees. Verify locally using npm tests and authenticated localhost MCP E2E.

## Constraints

- All source changes restricted to existing linked QA worktree `feat/chat-native-harness`. Never touch the main worktree.
- No model calls, paid API, ChatGPT Work, user's quotas, extra agents, remote tunnel, external data, commit, push or deploy.
- Only disposable synthetic files for scaling and edit tests; no prod data.
- Preserve user work and all uncommitted edits. Do not weaken permissions or command parsing to achieve benchmark improvements.
- Benchmark owner labels remain handwritten; do not silently relabel failing examples to claim accuracy.

## Success criteria

- No regression across 38 real-repository owner questions and 12 synthetic multilingual cases; every new ranking rule has a failing test that precedes its implementation.
- Scale benchmark records whether desired late files are discoverable; if not, report or repair it with a security-preserving test.
- Commands remain fully compatible on the existing path; performance claims include repeated medians and tails and acknowledge noise.
- Full npm test and authenticated local HTTP E2E pass, git diff checks clean, main tree status unchanged.

## Unproven outcome

Without the user's model quota or a paid API, these tests cannot establish that a real ChatGPT model has higher task-completion quality. No such claim will be made.