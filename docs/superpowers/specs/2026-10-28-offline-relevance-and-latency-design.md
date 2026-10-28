# Offline Task Retrieval and Edit Latency QA Design

## Intent

Measure whether Local Coder QA makes code ownership easier to discover and edits more efficient, without invoking any model or paid service. The previous six-query retrieval benchmark was too small to support a broad quality claim.

## Constraints

- Work only in the existing isolated `feat/chat-native-harness` worktree.
- No OpenAI API, ChatGPT Work, paid model, live project, tunnel, external service, additional agents, commit, push, or deploy.
- Use disposable fixtures and localhost MCP. Preserve every existing uncommitted user change.

## Approaches

- **Tune against six queries only:** rejected because this overfits and hides misses.
- **Add embeddings and a model-based semantic index:** rejected because the user forbids paid/model calls and it changes the architecture.
- **Offline golden retrieval plus bounded lexical refinements (selected by user opting into execution):** hand-label 30–50 real tasks, record top-k/MRR/latency, add multilingual synthetic regressions, fix demonstrable keyword morphology defects, and remeasure.

## Behavior and acceptance

- The task-context owner benchmark reports exact Hit@1/3/6 and reciprocal rank per query; not model accuracy.
- Simple English inflections such as plural source filenames and common `-ing` verbs may match their base forms without scanning ignored or sensitive paths.
- Code implementation ranking must not promote incidental copies of task text inside benchmark/test scripts.
- Edit performance is decomposed locally into patch/checkpoint, command verification and HTTP overhead; optimize only verified dominant work without changing the shell contract.
- Run `npm test`, localhost authenticated MCP E2E, `git diff --check`, and verify the active worktree remains unchanged. Any unsupported model-level claim is explicitly withheld.