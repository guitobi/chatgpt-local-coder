/**
 * Verify slim tool profile exposes expected tools only.
 */
import { SLIM_CHATGPT_TOOLS, FOCUSED_CHATGPT_TOOLS, getChatGptToolProfile, shouldExposeTool } from "../dist/lib/tool-profile.js";

const ALL_KNOWN = [
  "read_text_file", "write_file", "apply_patch", "glob", "grep", "run_command",
  "git_status", "mcp_call", "delete_directory", "read_file_base64",
];

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of ["apply_patch", "glob", "remember", "load_path_rules", "inspect_code", "diagnose_failure", "edit_and_verify", "task_context"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  if (shouldExposeTool("delete_directory", "slim")) throw new Error("delete_directory hidden");
  ok("heavy tools hidden in slim");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");

  if (FOCUSED_CHATGPT_TOOLS.size >= SLIM_CHATGPT_TOOLS.size || FOCUSED_CHATGPT_TOOLS.size < 20) {
    throw new Error("focused tool catalog must be meaningfully smaller without removing core tools");
  }
  for (const name of ["read_text_file", "write_file", "apply_patch", "glob", "grep", "inspect_code", "diagnose_failure", "edit_and_verify", "task_context", "run_command", "git_status", "project_context", "ponytail_turn", "rewind", "load_skill"]) {
    if (!shouldExposeTool(name, "focused")) throw new Error(`${name} missing from focused`);
  }
  for (const name of ["multi_edit", "edit_file", "shell_status", "node_repl", "mcp_servers", "git_restore"]) {
    if (shouldExposeTool(name, "focused")) throw new Error(`${name} must stay available via slim/full, not focused`);
    if (!shouldExposeTool(name, "slim")) throw new Error(`${name} was accidentally removed from legacy slim`);
  }
  ok(`focused profile has ${FOCUSED_CHATGPT_TOOLS.size} practical tools`);

  const previous = process.env.CHATGPT_TOOL_PROFILE;
  try {
    delete process.env.CHATGPT_TOOL_PROFILE;
    if (getChatGptToolProfile() !== "focused") throw new Error("QA default should be focused");
    process.env.CHATGPT_TOOL_PROFILE = "slim";
    if (getChatGptToolProfile() !== "slim") throw new Error("explicit slim must remain supported");
    process.env.CHATGPT_TOOL_PROFILE = "full";
    if (getChatGptToolProfile() !== "full") throw new Error("explicit full must remain supported");
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
    else process.env.CHATGPT_TOOL_PROFILE = previous;
  }
  ok("focused default and explicit legacy modes are distinct");
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);