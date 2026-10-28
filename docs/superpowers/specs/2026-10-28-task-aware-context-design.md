# Task-Aware Repository Context — QA Design

**Intent:** Improve model decisions without changing the model: make a single read-only MCP call identify relevant source files, neighboring tests, and concise evidence for a natural-language coding task.

**Non-goals:** Model inference, semantic embeddings, arbitrary code execution, replacing full source reads, or claiming better task success before agent-level testing.

**Constraints:** Offline only; respect `.gitignore`; exclude hidden paths, secrets, dependencies and build output; no symlink traversal; deterministic ordering; bounded files, bytes and work; read-only; QA worktree only. Real-world tasks may use Ukrainian or English words and exact code symbols.

**Approaches:**

1. **Full repository snapshot:** easy for an agent but too expensive and can leak unrelated files. Rejected.
2. **Filename-only recommendation:** cheap but misses symbols found only in code. Rejected as incomplete.
3. **Bounded lexical retrieval (chosen):** `rg --files` and fixed-string source matching, then path/content ranking and excerpts. No model or API costs. Fallback gives explicit limited diagnostics if ripgrep is absent.

**Interface:** `task_context({task,path?,max_files?,max_chars?})` returns `{root,task,terms,files:[{path,score,reasons,lines:[{number,text}]}],searched_files,truncated,warnings}`. Each snippet is evidence, never a claim that other files are irrelevant. `max_files` defaults to 6, `max_chars` to 9000.

**Agent guidance:** Use once when starting unfamiliar, multi-file repository tasks. Follow with `read_text_file` and `load_path_rules` on files about to be edited. Do not call for a trivial known-path change.

**Success checks:** A synthetic task targeting a symbol selects the correct implementation and test; ignored and sensitive files stay excluded; snippets and total payload are bounded; MCP tools/list and actual call pass on the focused profile; existing suite passes. End-to-end model quality remains unmeasured without API/Work.