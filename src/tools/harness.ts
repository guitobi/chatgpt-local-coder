import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { inspectCode, diagnoseFailure, editAndVerify } from "../lib/harness-operations.js";

export function registerHarnessTools(server: McpServer, defaultCwd: string, shellTimeoutSec: number): void {
  server.registerTool("edit_and_verify", {
    title: "Edit and Verify Single File",
    description: "Apply a checkpointed single-file patch, then run explicit verification. command_mode=shell (default) preserves shell semantics; command_mode=argv takes a JSON array command, avoids shell startup and does not interpret operators or cwd directives. Failed tests retain edits and checkpoint. dry_run skips command.",
    inputSchema: {
      path: z.string().min(1).max(4096).describe("Absolute or workspace-relative path to an existing text file"),
      patch: z.string().min(1).max(64_000).describe("Single-file @@ hunk patch; multi-file formats are rejected"),
      command: z.string().min(1).max(16_000).describe("Explicit test/build command; may itself modify files"),
      command_mode: z.enum(["shell", "argv"]).optional().default("shell").describe("shell (default): existing semantics; argv: command is a JSON array of executable and arguments, no shell parsing"),
      working_directory: z.string().min(1).max(4096).optional().describe("Run command here (default: edited file's directory)"),
      dry_run: z.boolean().optional().default(false),
      max_output_chars: z.number().int().min(128).max(20_000).optional().default(6_000),
      timeout_ms: z.number().int().min(100).max(120_000).optional(),
    },
    annotations: toolAnnotations("command"),
  }, async ({ path: filePath, patch, command, command_mode, working_directory, dry_run, max_output_chars, timeout_ms }) => {
    try {
      const result = await editAndVerify({
        path: filePath,
        patch,
        command,
        commandMode: command_mode,
        workingDirectory: working_directory,
        dryRun: dry_run,
        maxOutputChars: max_output_chars,
        timeoutMs: timeout_ms ?? Math.min(120_000, Math.max(100, shellTimeoutSec * 1000)),
      });
      await audit({
        tool: "edit_and_verify", action: "edit-and-verify", target: result.patch.path,
        status: result.ok ? (dry_run ? "dry-run" : "ok") : "error",
        details: {
          command: dry_run ? "[skipped: dry-run]" : command,
          checkpoint_id: result.patch.checkpoint_id,
          exit_code: result.verification?.exit_code ?? null,
          timed_out: result.verification?.timed_out ?? false,
        },
      });
      const status = dry_run
        ? "dry-run: patch preview; command not executed"
        : result.verification_error
          ? "verification runner failed; patch retained"
        : result.verification?.timed_out
          ? "verification timed out; patch retained"
          : result.patch.hooks.failed
            ? `${result.patch.hooks.failed} post-edit hook(s) failed; patch retained`
          : `verification exit ${result.verification?.exit_code}; patch retained`;
      return toolResult("edit_and_verify", result, { ok: result.ok, summary: `edit_and_verify: ${status}` });
    } catch (error) {
      await audit({
        tool: "edit_and_verify", action: "edit-and-verify", target: filePath,
        status: "error", details: { phase: "preflight-or-patch" },
      });
      throw error;
    }
  });

  server.registerTool("inspect_code", {
    title: "Inspect Code",
    description: "Read-only combined code search, bounded source excerpts and Git status. Useful before editing a project.",
    inputSchema: {
      path: z.string().min(1).max(4096).optional().describe("Project directory or source file; defaults to workspace"),
      query: z.string().min(1).max(1024).describe("Case-sensitive regular expression to search for"),
      glob: z.string().min(1).max(256).optional().describe("Optional file-name pattern, e.g. *.ts"),
      max_matches: z.number().int().min(1).max(50).optional().default(20),
      context_lines: z.number().int().min(0).max(5).optional().default(2),
    },
    annotations: toolAnnotations("read"),
  }, async ({ path: searchPath, query, glob, max_matches, context_lines }) => {
    const root = searchPath ? await validatePath(searchPath) : defaultCwd;
    try {
      const result = await inspectCode({
        root, query, glob, maxMatches: max_matches, contextLines: context_lines,
      });
      await audit({
        tool: "inspect_code", action: "inspect", target: root, status: "ok",
        details: { query, glob, matches: result.matches.length },
      });
      return toolResult("inspect_code", result, {
        summary: `inspect_code: ${result.matches.length} match(es) in ${result.excerpts.length} excerpted file(s)`,
      });
    } catch (error) {
      await audit({ tool: "inspect_code", action: "inspect", target: root, status: "error" });
      throw error;
    }
  });

  server.registerTool("diagnose_failure", {
    title: "Diagnose Command Failure",
    description: "Execute explicit verification and return bounded output tails, error locations and Git state. Default shell semantics; opt into command_mode=argv with a JSON array for a direct executable. Commands may modify files.",
    inputSchema: {
      command: z.string().min(1).max(16_000).describe("Explicit command to execute; can modify files"),
      command_mode: z.enum(["shell", "argv"]).optional().default("shell").describe("argv takes a JSON array of executable and arguments; default shell preserves existing behavior"),
      path: z.string().min(1).max(4096).optional().describe("Working directory; defaults to workspace"),
      max_output_chars: z.number().int().min(128).max(20_000).optional().default(6_000),
      timeout_ms: z.number().int().min(100).max(120_000).optional(),
    },
    annotations: toolAnnotations("command"),
  }, async ({ command, command_mode, path: commandPath, max_output_chars, timeout_ms }) => {
    const root = commandPath ? await validatePath(commandPath) : defaultCwd;
    try {
      const result = await diagnoseFailure({
        root, command, maxOutputChars: max_output_chars,
        commandMode: command_mode,
        timeoutMs: timeout_ms ?? Math.min(120_000, Math.max(100, shellTimeoutSec * 1000)),
      });
      const ok = !result.timed_out && result.exit_code === 0;
      await audit({
        tool: "diagnose_failure", action: "command", target: result.cwd,
        status: ok ? "ok" : "error",
        details: { command, exit_code: result.exit_code, timed_out: result.timed_out },
      });
      return toolResult("diagnose_failure", result, {
        ok, summary: result.timed_out ? "diagnose_failure: command timed out" : `diagnose_failure: exit ${result.exit_code}`,
      });
    } catch (error) {
      await audit({ tool: "diagnose_failure", action: "command", target: root, status: "error", details: { command } });
      throw error;
    }
  });
}