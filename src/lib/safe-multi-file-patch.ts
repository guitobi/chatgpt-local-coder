import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { applyUnifiedPatchToText, buildSimpleDiff, parseMultiFilePatch, type MultiPatchFileOp, type MultiPatchResult } from "./patch.js";
import { checkpointBefore, getCheckpointConfig } from "./checkpoint.js";
import { requireWriteAllowed } from "./permissions.js";
import { validatePath } from "./path-security.js";
import { runPostEditHooks } from "./post-edit-hooks.js";

const MAX_FILES = 20;
const MAX_PATCH_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 4_000;

interface PreparedEdit {
  op: MultiPatchFileOp;
  before: Buffer | null;
  after: Buffer | null;
  diff: string;
  identity: { dev: number; ino: number } | null;
  parents: Array<{ path: string; dev: number; ino: number }>;
  createdIdentity?: { dev: number; ino: number };
}

export interface SafeMultiPatchResult {
  ok: boolean;
  files: Array<MultiPatchResult & { diff_truncated: boolean }>;
  dry_run: boolean;
  safe: true;
  checkpoint_id: string | null;
  rollback: { attempted: boolean; complete: boolean; errors: string[] };
  hooks: { executed: number; failed: number; truncated: boolean; results: Array<{ file: string; exit_code: number | null; stderr: string }> };
  error?: string;
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureNoSymlinkAncestors(base: string, target: string): Promise<void> {
  const start = await fs.lstat(base);
  if (!start.isDirectory() || start.isSymbolicLink()) throw new Error("Safe patch base must be a real directory");
  for (let dir = path.dirname(target); inside(base, dir); dir = path.dirname(dir)) {
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe parent directory: ${dir}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function parentIdentities(base: string, target: string): Promise<PreparedEdit["parents"]> {
  const parents: PreparedEdit["parents"] = [];
  for (let dir = path.dirname(target); dir === base || inside(base, dir); dir = path.dirname(dir)) {
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${dir}`);
      parents.push({ path: dir, dev: stat.dev, ino: stat.ino });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return parents;
}

async function assertSameParents(parents: PreparedEdit["parents"]): Promise<void> {
  for (const parent of parents) {
    const stat = await fs.lstat(parent.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      stat.dev !== parent.dev || stat.ino !== parent.ino) {
      throw new Error(`Patch parent directory changed since preflight: ${parent.path}`);
    }
  }
}

async function readOriginal(op: MultiPatchFileOp): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(op.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe or non-file patch target: ${op.path}`);
    if (op.operation === "create") throw new Error(`File already exists: ${op.path}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds safe patch size limit: ${op.path}`);
    return await fs.readFile(op.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (op.operation !== "create") throw new Error(`File does not exist: ${op.path}`);
    return null;
  }
}

async function preflight(patchText: string, baseDir: string): Promise<PreparedEdit[]> {
  if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES) throw new Error("Safe multi-file patch exceeds 128 KiB");
  const ops = parseMultiFilePatch(patchText, baseDir);
  if (ops.length < 1 || ops.length > MAX_FILES) throw new Error(`Safe multi-file patch requires 1-${MAX_FILES} files`);
  const seen = new Set<string>();
  const prepared: PreparedEdit[] = [];
  for (const op of ops) {
    op.path = await validatePath(op.path);
    if (!inside(baseDir, op.path)) throw new Error(`Patch target outside base directory: ${op.path}`);
    const key = process.platform === "win32" ? op.path.toLowerCase() : op.path;
    if (seen.has(key)) throw new Error(`Duplicate patch target: ${op.path}`);
    seen.add(key);
    await ensureNoSymlinkAncestors(baseDir, op.path);
    const parents = await parentIdentities(baseDir, op.path);
    const before = await readOriginal(op);
    const sourceStat = before === null ? null : await fs.lstat(op.path);
    if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink())) {
      throw new Error(`Unsafe patch target: ${op.path}`);
    }
    if (sourceStat) {
      await ensureNoSymlinkAncestors(baseDir, op.path);
      const [canonicalBase, canonicalTarget] = await Promise.all([
        fs.realpath(baseDir), fs.realpath(op.path),
      ]);
      if (!inside(canonicalBase, canonicalTarget)) {
        throw new Error(`Patch target resolves outside base directory: ${op.path}`);
      }
    }
    if (before !== null && (before.includes(0) || !Buffer.from(before.toString("utf8"), "utf8").equals(before))) {
      throw new Error(`Safe patch requires UTF-8 text: ${op.path}`);
    }
    let after: Buffer | null;
    if (op.operation === "delete") after = null;
    else if (op.operation === "create") after = Buffer.from(op.content ?? "", "utf8");
    else {
      if (!op.patch?.trim()) throw new Error(`Update patch has no hunks: ${op.path}`);
      after = Buffer.from(applyUnifiedPatchToText(before!.toString("utf8"), op.patch, { strictNumbered: true }), "utf8");
    }
    const diff = op.operation === "delete" ? "[deleted]" : buildSimpleDiff(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "");
    prepared.push({
      op, before, after, diff,
      identity: sourceStat ? { dev: sourceStat.dev, ino: sourceStat.ino } : null,
      parents,
    });
  }
  return prepared;
}

async function openVerifiedTarget(item: PreparedEdit, checkContent: boolean): Promise<FileHandle> {
  if (!item.identity || item.before === null) throw new Error("Missing original file identity");
  // An already-open handle cannot be redirected by a later path/ancestor swap.
  const handle = await fs.open(item.op.path, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== item.identity.dev || stat.ino !== item.identity.ino) {
      throw new Error(`Patch target identity changed since preflight: ${item.op.path}`);
    }
    if (checkContent && !(await handle.readFile()).equals(item.before)) {
      throw new Error(`File changed since preflight: ${item.op.path}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writeThroughHandle(handle: FileHandle, content: Buffer): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
    if (bytesWritten === 0) throw new Error("Cannot complete safe patch write");
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

function fileResults(prepared: PreparedEdit[]): SafeMultiPatchResult["files"] {
  return prepared.map(({ op, diff }) => ({
    path: op.path, operation: op.operation, ok: true,
    diff: diff.slice(0, MAX_DIFF_CHARS), diff_truncated: diff.length > MAX_DIFF_CHARS,
  }));
}

/** Strict preflight, one checkpoint, then best-effort rollback on write failure. */
export async function applySafeMultiFilePatch(
  patchText: string,
  options: { baseDir: string; dryRun?: boolean },
): Promise<SafeMultiPatchResult> {
  requireWriteAllowed();
  const baseDir = await validatePath(options.baseDir);
  const dryRun = options.dryRun ?? false;
  const prepared = await preflight(patchText, baseDir);
  const baseResult: SafeMultiPatchResult = {
    ok: true, files: fileResults(prepared), safe: true, dry_run: dryRun, checkpoint_id: null,
    rollback: { attempted: false, complete: true, errors: [] },
    hooks: { executed: 0, failed: 0, truncated: false, results: [] },
  };
  if (dryRun) return baseResult;
  if (getCheckpointConfig().enabled !== true) throw new Error("Safe multi-file patch requires checkpoints enabled");
  baseResult.checkpoint_id = await checkpointBefore("apply_patch_safe", prepared.map(item => item.op.path), {
    require_complete: true,
  });
  if (!baseResult.checkpoint_id) throw new Error("Safe multi-file patch requires an available checkpoint");

  const touched: PreparedEdit[] = [];
  try {
    for (const item of prepared) {
      // Reject modifications made externally after preflight, before writing this file.
      await ensureNoSymlinkAncestors(baseDir, item.op.path);
      await assertSameParents(item.parents);
      const current = await readOriginal(item.op.operation === "create" ? item.op : { ...item.op, operation: "update" });
      // The read above is asynchronous: a directory can be swapped for a
      // junction after the first parent check, even if its file bytes match.
      await ensureNoSymlinkAncestors(baseDir, item.op.path);
      await assertSameParents(item.parents);
      if (item.before === null ? current !== null : current === null || !current.equals(item.before)) {
        throw new Error(`File changed since preflight: ${item.op.path}`);
      }
      if (item.op.operation === "create") {
        await fs.mkdir(path.dirname(item.op.path), { recursive: true });
        await ensureNoSymlinkAncestors(baseDir, item.op.path);
        await assertSameParents(item.parents);
        const handle = await fs.open(item.op.path, "wx");
        touched.push(item);
        try {
          const stat = await handle.stat();
          item.createdIdentity = { dev: stat.dev, ino: stat.ino };
          await assertSameParents(item.parents);
          await ensureNoSymlinkAncestors(baseDir, item.op.path);
          const [canonicalBase, canonicalTarget] = await Promise.all([
            fs.realpath(baseDir), fs.realpath(item.op.path),
          ]);
          if (!inside(canonicalBase, canonicalTarget)) throw new Error(`Unsafe created target path: ${item.op.path}`);
          await handle.writeFile(item.after!);
        } finally { await handle.close(); }
      } else {
        if (item.op.operation === "delete") {
          // Verify the opened inode, not just bytes read through a mutable path.
          const handle = await openVerifiedTarget(item, true);
          try {
            await ensureNoSymlinkAncestors(baseDir, item.op.path);
            const currentStat = await fs.lstat(item.op.path);
            if (currentStat.dev !== item.identity!.dev || currentStat.ino !== item.identity!.ino) {
              throw new Error(`Patch target identity changed since preflight: ${item.op.path}`);
            }
            await fs.unlink(item.op.path);
            touched.push(item);
          } finally {
            await handle.close();
          }
        } else {
          await ensureNoSymlinkAncestors(baseDir, item.op.path);
          await assertSameParents(item.parents);
          const handle = await openVerifiedTarget(item, true);
          try {
            touched.push(item);
            await writeThroughHandle(handle, item.after!);
          } finally {
            await handle.close();
          }
        }
      }
    }
  } catch (error) {
    const errors: string[] = [];
    for (const item of touched.reverse()) {
      try {
        await ensureNoSymlinkAncestors(baseDir, item.op.path);
        await assertSameParents(item.parents);
        if (item.before === null) {
          const handle = await fs.open(item.op.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          try {
            const [opened, named] = await Promise.all([handle.stat(), fs.lstat(item.op.path)]);
            if (!item.createdIdentity || !opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
              opened.dev !== item.createdIdentity.dev || opened.ino !== item.createdIdentity.ino ||
              named.dev !== item.createdIdentity.dev || named.ino !== item.createdIdentity.ino ||
              !(await handle.readFile()).equals(item.after!)) {
              throw new Error("Created file identity or content changed before rollback: " + item.op.path);
            }
            await ensureNoSymlinkAncestors(baseDir, item.op.path);
            await assertSameParents(item.parents);
            await fs.unlink(item.op.path);
          } finally {
            await handle.close();
          }
        } else if (item.op.operation === "delete") {
          // Never overwrite a newly-created file or follow a leaf symlink during rollback.
          const handle = await fs.open(item.op.path, "wx");
          try { await handle.writeFile(item.before); } finally { await handle.close(); }
        } else {
          const handle = await openVerifiedTarget(item, false);
          try { await writeThroughHandle(handle, item.before); } finally { await handle.close(); }
        }
      } catch (rollbackError) {
        errors.push(`${item.op.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`.slice(0, 320));
      }
    }
    baseResult.ok = false;
    baseResult.rollback = { attempted: touched.length > 0, complete: errors.length === 0, errors: errors.slice(0, MAX_FILES) };
    baseResult.error = String(error instanceof Error ? error.message : error).slice(0, 500);
    baseResult.files = [];
    return baseResult;
  }

  try {
    const raw = await runPostEditHooks(prepared.map(item => item.op.path));
    const hooks = (raw?.post_edit_hooks ?? []) as Array<Record<string, unknown>>;
    baseResult.hooks = {
      executed: hooks.length,
      failed: hooks.filter(hook => hook.exit_code !== 0).length,
      truncated: hooks.length > 5,
      results: hooks.slice(0, 5).map(hook => ({
        file: String(hook.file ?? "").slice(0, 240),
        exit_code: typeof hook.exit_code === "number" ? hook.exit_code : null,
        stderr: String(hook.stderr ?? "").slice(-300),
      })),
    };
    baseResult.ok = baseResult.hooks.failed === 0;
  } catch (error) {
    baseResult.ok = false;
    baseResult.error = `Post-edit hooks failed to execute: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  }
  return baseResult;
}