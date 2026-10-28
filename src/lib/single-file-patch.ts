import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { validatePath } from "./path-security.js";
import { requireWriteAllowed } from "./permissions.js";
import { isMultiFilePatch, applyUnifiedPatchToText, buildSimpleDiff } from "./patch.js";
import { checkpointBefore } from "./checkpoint.js";
import { audit } from "./audit.js";
import { enrichAfterEdit } from "./edit-enrichment.js";

export interface SingleFilePatchOptions {
  path: string;
  patch: string;
  dryRun?: boolean;
  checkpointTool?: string;
}

export interface SingleFilePatchResult {
  path: string;
  diff: string;
  dry_run: boolean;
  checkpoint_id: string | null;
}

async function rejectSymlinkPath(file: string): Promise<void> {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe symlink or non-directory patch parent: ${dir}`);
    }
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe symlink or non-file patch target: ${file}`);
  }
}

async function verifiedRead(file: string): Promise<{ content: string; identity: { dev: number; ino: number } }> {
  await rejectSymlinkPath(file);
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
      opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error(`Patch target identity changed during read: ${file}`);
    }
    return { content: await handle.readFile({ encoding: "utf8" }), identity: { dev: opened.dev, ino: opened.ino } };
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof fs.open>>, content: Buffer): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("Unable to finish single-file patch write");
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

async function writeVerified(file: string, identity: { dev: number; ino: number }, before: string, after: string): Promise<void> {
  await rejectSymlinkPath(file);
  const handle = await fs.open(file, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
      opened.dev !== identity.dev || opened.ino !== identity.ino ||
      named.dev !== identity.dev || named.ino !== identity.ino) {
      throw new Error(`Patch target identity changed since preflight: ${file}`);
    }
    if (!(await handle.readFile()).equals(Buffer.from(before, "utf8"))) {
      throw new Error(`Patch target content changed since preflight: ${file}`);
    }
    await rejectSymlinkPath(file);
    const content = Buffer.from(after, "utf8");
    try {
      await writeAll(handle, content);
    } catch (error) {
      // The handle stays bound to the original file even if its path was renamed.
      const original = Buffer.from(before, "utf8");
      try {
        await writeAll(handle, original);
      } catch { /* Retain the original error; checkpoint recovery remains available. */ }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

/** Shared single-file edit path for the original MCP tool and harness. */
export async function applySingleFilePatch(options: SingleFilePatchOptions): Promise<SingleFilePatchResult> {
  requireWriteAllowed();
  if (isMultiFilePatch(options.patch)) {
    throw new Error("This operation requires a single-file patch; multi-file patches are not supported");
  }
  const filePath = await validatePath(options.path);
  const { content: original, identity } = await verifiedRead(filePath);
  const tool = options.checkpointTool ?? "apply_patch";
  const dryRun = options.dryRun ?? false;
  const next = applyUnifiedPatchToText(original, options.patch, {
    strictNumbered: tool === "edit_and_verify",
  });
  const diff = buildSimpleDiff(original, next);
  const checkpointId = await checkpointBefore(tool, [filePath], {
    dry_run: dryRun,
    require_complete: tool === "edit_and_verify",
  });
  if (tool === "edit_and_verify" && !dryRun && !checkpointId) {
    throw new Error("edit_and_verify requires an available checkpoint before editing");
  }
  if (!dryRun) await writeVerified(filePath, identity, original, next);
  await audit({ tool, action: "patch", target: filePath, status: dryRun ? "dry-run" : "ok" });
  return enrichAfterEdit(
    { path: filePath, diff, dry_run: dryRun, checkpoint_id: checkpointId },
    [filePath],
    dryRun,
  );
}