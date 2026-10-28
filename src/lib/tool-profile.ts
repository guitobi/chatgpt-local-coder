import fs from "fs";
import path from "path";

export type ToolProfileName = "full" | "slim" | "focused";

export const LOCAL_TOOL_CATALOG = [
  "read_text_file", "write_file", "edit_file", "multi_edit", "apply_patch", "glob", "grep", "list_directory",
  "inspect_code", "diagnose_failure", "edit_and_verify",
  "run_command", "shell_status", "shell_reset", "start_process", "process_output", "node_repl", "ponytail_turn",
  "git_status", "git_diff", "git_add", "git_commit", "git_restore", "agent_status", "project_context", "task_context",
  "remember", "load_path_rules", "list_skills", "load_skill", "rewind", "mcp_servers", "mcp_tools", "mcp_call",
];

interface LocalToolOverrides {
  enabled?: string[];
  disabled?: string[];
}

const overridesPath = () => path.resolve(process.cwd(), "profiles", "tool-overrides.json");

export function getLocalToolOverrides(): LocalToolOverrides {
  try {
    return JSON.parse(fs.readFileSync(overridesPath(), "utf-8")) as LocalToolOverrides;
  } catch {
    return {};
  }
}

export function saveLocalToolOverrides(next: LocalToolOverrides): void {
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(next, null, 2));
}

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "inspect_code",
  "diagnose_failure",
  "edit_and_verify",
  "list_directory",
  "run_command",
  "shell_status",
  "start_process",
  "process_output",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_restore",
  "agent_status",
  "project_context",
  "task_context",
  "remember",
  "load_path_rules",
  "list_skills",
  "load_skill",
  "node_repl",
  "ponytail_turn",
  "rewind",
  "mcp_servers",
]);

// Default ChatGPT workflow: retain code search, patches, verification, Git,
// checkpoints, project instructions and the user's Ponytail tool. Specialized
// duplicate operations remain available with CHATGPT_TOOL_PROFILE=slim/full.
const SPECIALIZED_TOOLS = new Set([
  "edit_file", "multi_edit", "shell_status", "node_repl", "mcp_servers", "git_restore",
]);
export const FOCUSED_CHATGPT_TOOLS = new Set(
  [...SLIM_CHATGPT_TOOLS].filter((name) => !SPECIALIZED_TOOLS.has(name))
);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "focused").trim().toLowerCase();
  return raw === "full" ? "full" : raw === "slim" ? "slim" : "focused";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  const overrides = getLocalToolOverrides();
  if ((overrides.disabled ?? []).includes(name)) return false;
  if (profile === "full") return true;
  const names = profile === "focused" ? FOCUSED_CHATGPT_TOOLS : SLIM_CHATGPT_TOOLS;
  return names.has(name) || (overrides.enabled ?? []).includes(name);
}
