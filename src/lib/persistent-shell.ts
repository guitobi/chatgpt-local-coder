import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";

let sessionCwd: string | null = null;
let sessionInitializedAt: string | null = null;
let persistenceRoot: string | null = null;
const history: string[] = [];
const MAX_HISTORY = 50;
const MAX_CAPTURE_CHARS = 256 * 1024;

function appendLogTail(previous: string, chunk: Buffer): string {
  const combined = previous + chunk.toString("utf8");
  return combined.length > MAX_CAPTURE_CHARS ? combined.slice(-MAX_CAPTURE_CHARS) : combined;
}

function terminateCommandTree(pid: number | undefined, child: ReturnType<typeof spawn>): void {
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    // Node's child.kill() kills only the PowerShell wrapper, not its descendants.
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore",
    });
    killer.on("error", () => child.kill("SIGKILL"));
    killer.on("close", code => {
      if (code !== 0) child.kill("SIGKILL");
    });
  } else {
    // Detached child owns a fresh process group; signal the entire group.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function setShellPersistenceRoot(workspaceRoot: string): void {
  persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
}

/** Restore cwd from disk (ChatGPT = new MCP session per tool call). */
export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  setShellPersistenceRoot(defaultCwd);
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd);
  if (saved?.cwd) {
    sessionCwd = path.resolve(saved.cwd);
    sessionInitializedAt = saved.updated_at;
    if (saved.recent_commands?.length) {
      history.length = 0;
      history.push(...saved.recent_commands.slice(-MAX_HISTORY));
    }
    return;
  }
  initShellSession(defaultCwd);
}

export function getShellCwd(): string {
  if (!sessionCwd) throw new Error("Shell session not initialized");
  return sessionCwd;
}

export function resetShellSession(cwd: string): void {
  sessionCwd = path.resolve(cwd);
  sessionInitializedAt = new Date().toISOString();
  if (persistenceRoot) {
    void saveGlobalShellState(persistenceRoot, sessionCwd, undefined, null);
  }
}

export function getShellStatus() {
  return {
    active: sessionCwd !== null,
    cwd: sessionCwd,
    started_at: sessionInitializedAt,
    recent_commands: [...history].slice(-10),
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Cập nhật cwd khi gặp cd / Set-Location ở đầu command (giống Bash persistent). */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd" };
}

export function transpileCompoundOperators(cmd: string): string {
  if (!cmd.includes("&&") && !cmd.includes("||")) return cmd;

  const tokens: { type: "text" | "&&" | "||"; value: string }[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < cmd.length) {
    const char = cmd[i];
    const nextChar = cmd[i + 1];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
    } else if (!inSingleQuote && !inDoubleQuote && char === "&" && nextChar === "&") {
      if (current.trim()) tokens.push({ type: "text", value: current.trim() });
      tokens.push({ type: "&&", value: "&&" });
      current = "";
      i += 2;
    } else if (!inSingleQuote && !inDoubleQuote && char === "|" && nextChar === "|") {
      if (current.trim()) tokens.push({ type: "text", value: current.trim() });
      tokens.push({ type: "||", value: "||" });
      current = "";
      i += 2;
    } else {
      current += char;
      i++;
    }
  }

  if (current.trim()) tokens.push({ type: "text", value: current.trim() });
  if (tokens.length <= 1) return cmd;

  let result = `${tokens[0].value}; $__localCoderSuccess = $?`;

  for (let j = 1; j < tokens.length; j += 2) {
    const op = tokens[j];
    const nextCmd = tokens[j + 1]?.value;
    if (!nextCmd) break;

    if (op.type === "&&") {
      result += `; if ($__localCoderSuccess) { ${nextCmd}; $__localCoderSuccess = $? }`;
    } else if (op.type === "||") {
      result += `; if (-not $__localCoderSuccess) { ${nextCmd}; $__localCoderSuccess = $? }`;
    }
  }

  return result;
}

export function getWinShell(): { shell: string; isPwsh: boolean } {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell && /(?:^|[\\/])(pwsh|powershell)(?:\.exe)?$/i.test(configuredShell)) {
    return { shell: configuredShell, isPwsh: /pwsh(?:\.exe)?$/i.test(configuredShell) };
  }

  const pwshPaths = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
  ];
  for (const p of pwshPaths) {
    if (fs.existsSync(p)) return { shell: p, isPwsh: true };
  }

  const sysPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (fs.existsSync(sysPowerShell)) return { shell: sysPowerShell, isPwsh: false };

  return { shell: "powershell.exe", isPwsh: false };
}

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  return new Promise((resolve, reject) => {
    let effectiveCommand = command;
    let shell = "bash";
    let args: string[] = ["-lc", effectiveCommand];

    if (process.platform === "win32") {
      const winShellInfo = getWinShell();
      shell = winShellInfo.shell;
      if (!winShellInfo.isPwsh) {
        effectiveCommand = transpileCompoundOperators(command);
      }
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
    }

    const child = spawn(shell, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CI: "true",
        PAGER: "cat",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
        npm_config_yes: "true",
      },
    });

    if (child.stdin) {
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateCommandTree(child.pid, child);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout = appendLogTail(stdout, d); });
    child.stderr?.on("data", (d: Buffer) => { stderr = appendLogTail(stderr, d); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // Preserve partial diagnostics for callers such as diagnose_failure.
        // Keep the existing rejection contract for run_command.
        reject(Object.assign(new Error(`Command timed out after ${timeoutMs / 1000}s`), {
          timed_out: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        }));
        return;
      }
      resolve({
        command,
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
        timed_out: false,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Explicit, shell-free argv execution. Does not reinterpret or persist shell state. */
export function execArgvInDirectory(argv: string[], cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      env: {
        ...process.env,
        CI: "true",
        PAGER: "cat",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
        npm_config_yes: "true",
      },
    });
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateCommandTree(child.pid, child);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout = appendLogTail(stdout, d); });
    child.stderr?.on("data", (d: Buffer) => { stderr = appendLogTail(stderr, d); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(Object.assign(new Error(`Command timed out after ${timeoutMs / 1000}s`), {
          timed_out: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        }));
        return;
      }
      resolve({
        command: JSON.stringify(argv),
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
        timed_out: false,
      });
    });
  });
}

export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  if (!sessionCwd) initShellSession(defaultCwd);

  if (workingDirectory) {
    sessionCwd = path.resolve(await Promise.resolve(workingDirectory));
  }

  const { cwd, command: effective } = applyCwdDirectives(sessionCwd!, command);
  sessionCwd = cwd;

  history.push(effective);
  if (history.length > MAX_HISTORY) history.shift();

  const result = await runOnce(effective, cwd, timeoutMs);
  sessionCwd = cwd;

  if (persistenceRoot) {
    const prev = await loadGlobalShellState(persistenceRoot, defaultCwd);
    await saveGlobalShellState(persistenceRoot, cwd, effective, prev);
  }

  return result;
}
