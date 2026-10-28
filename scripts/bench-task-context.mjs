import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildTaskContext } from "../dist/lib/task-context.js";

const root = path.resolve(process.cwd());
const samples = [];
// Human-labeled source owners: these are expected implementation files, not
// matches copied from buildTaskContext itself or a language-model evaluation.
const cases = [
  { task: "Fix numbered hunk insertion positioning", owner: "src/lib/patch.ts" },
  { task: "Fix timeout handling and child process cleanup", owners: ["src/lib/persistent-shell.ts", "src/lib/codex-hooks.ts"] },
  { task: "Improve task context search and ignore rules", owner: "src/lib/task-context.ts" },
  { task: "Make single-file patch reject symlink targets", owner: "src/lib/single-file-patch.ts" },
  { task: "Shrink the focused tool catalog in ChatGPT", owner: "src/lib/tool-profile.ts" },
  { task: "Enforce complete checkpoint before edit and verify", owner: "src/lib/checkpoint.ts" },
  { task: "Keep audit event records after a file operation", owner: "src/lib/audit.ts" },
  { task: "Format tool activity entries for agents", owner: "src/lib/activity-log.ts" },
  { task: "Restore repository changes from a Git snapshot", owner: "src/lib/git-snapshot.ts" },
  { task: "Load project memory saved from previous conversations", owner: "src/lib/project-memory.ts" },
  { task: "Summarize CLAUDE and AGENTS instructions", owner: "src/lib/instruction-context.ts" },
  { task: "Resolve absolute paths and workspace relative file paths", owner: "src/lib/path-security.ts" },
  { task: "Describe open permission profile for command and write operations", owner: "src/lib/permissions.ts" },
  { task: "Search files using globs and ignore rules", owners: ["src/lib/glob-search.ts", "src/lib/grep-search.ts"] },
  { task: "Fix ripgrep searching source content and regex fallback", owner: "src/lib/grep-search.ts" },
  { task: "Run configured post-edit hooks after changes", owner: "src/lib/post-edit-hooks.ts" },
  { task: "Show contextual information after editing a file", owner: "src/lib/edit-enrichment.ts" },
  { task: "Generate quickstart configuration for local tools", owner: "src/lib/quickstart.ts" },
  { task: "Load instruction skills from local markdown", owner: "src/lib/skills-loader.ts" },
  { task: "Assemble project instructions for a coding agent", owner: "src/lib/codex-agent-prompt.ts" },
  { task: "Handle node repl state in the MCP tool", owner: "src/tools/node-repl.ts" },
  { task: "Dispatch user prompt to ponytail controller", owner: "src/tools/ponytail.ts" },
  { task: "Restore edited files using rewind checkpoints", owner: "src/tools/rewind.ts" },
  { task: "Return project context with revision checks", owner: "src/tools/context.ts" },
  { task: "Expose upstream MCP tools through a bridge", owner: "src/tools/mcp-bridge.ts" },
  { task: "Restrict admin requests to localhost", owner: "src/admin/localhost-guard.ts" },
  { task: "Register administrative routes and settings", owner: "src/admin/routes.ts" },
  { task: "Expose file read and write operations", owner: "src/tools/filesystem.ts" },
  { task: "Implement git commit and diff commands", owner: "src/tools/git.ts" },
  { task: "Expose shell run and process output tools", owner: "src/tools/shell.ts" },
  { task: "Persist shell current directory across sessions", owners: ["src/lib/global-shell-state.ts", "src/lib/persistent-shell.ts"] },
  { task: "Manage OAuth tokens for MCP clients", owner: "src/lib/mcp-oauth-provider.ts" },
  { task: "Reconnect and supervise MCP upstream servers", owner: "src/lib/mcp-upstream-manager.ts" },
  { task: "Parse upstream server configuration JSON", owner: "src/lib/mcp-upstream-config.ts" },
  { task: "Proxy calls from clients to upstream tools", owner: "src/lib/mcp-tool-proxy.ts" },
  { task: "Expire and clean up stale MCP sessions", owner: "src/lib/mcp-session-manager.ts" },
  { task: "Apply safe multi-file patch with checkpoints", owner: "src/lib/safe-multi-file-patch.ts" },
  { task: "Extract bounded diagnostics from a failed shell command", owner: "src/lib/harness-operations.ts" },
];
const ranks = [];

for (let i = 0; i < cases.length + 12; i++) {
  const { task, owner, owners } = cases[i % cases.length];
  const start = performance.now();
  const result = await buildTaskContext({ root, task });
  const elapsed = performance.now() - start;
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 9000);
  assert.ok(result.files.every((file) => file.path.startsWith(root)));
  if (i >= cases.length) samples.push(elapsed);
  if (i < cases.length) {
    const accepted = owners ?? [owner];
    const rank = result.files.findIndex((file) => accepted.includes(path.relative(root, file.path).replaceAll("\\", "/"))) + 1;
    ranks.push(rank);
    console.log("QUERY", JSON.stringify({ task, accepted_owners: accepted, rank: rank || null,
      elapsed_ms: Number(elapsed.toFixed(1)), searched: result.searched_files,
      files: result.files.slice(0, 3).map((file) => ({ path: path.relative(root, file.path), score: file.score })),
      response_bytes: Buffer.byteLength(JSON.stringify(result)),
      warnings: result.warnings }));
  }
}

samples.sort((a, b) => a - b);
const at = (k) => ranks.filter((rank) => rank > 0 && rank <= k).length;
const mrr = ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / cases.length;
console.log("BENCH relevance", JSON.stringify({ evaluated: cases.length, hits_at_1: at(1), hits_at_3: at(3), hits_at_6: at(6), mrr: Number(mrr.toFixed(3)) }));
assert.equal(at(3), cases.length, "task_context must preserve all 38 hand-labeled owners within the top three");
console.log("BENCH task_context warm p50=" + samples[Math.ceil(samples.length * 0.5) - 1].toFixed(1)
  + "ms p95=" + samples[Math.ceil(samples.length * 0.95) - 1].toFixed(1)
  + "ms samples=" + samples.length);
console.log("BENCH scope: local ripgrep + file reads, not a model/API call");