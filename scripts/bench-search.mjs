import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { grepSearch } from "../dist/lib/grep-search.js";
import { toolResult } from "../dist/lib/tool-result.js";

const previousRg = process.env.LOCAL_CODER_RG_BIN;
const previousProfile = process.env.CHATGPT_TOOL_PROFILE;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-benchmark-"));
const repo = path.join(temporary, "repo with & [brackets]");
const binary = previousRg || "rg";
const hasRipgrep = spawnSync(binary, ["--version"], { windowsHide: true }).status === 0;

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(1),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1),
  };
}

async function measure(options, override) {
  process.env.LOCAL_CODER_RG_BIN = override;
  const samples = [];
  let output = "";
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    output = await grepSearch(options);
    const duration = performance.now() - start;
    if (i > 0) samples.push(duration); // Ignore the cold first call.
  }
  return { timing: percentiles(samples), output };
}

try {
  await fs.mkdir(repo, { recursive: true });
  const common = `${"ordinary source line\n".repeat(45)}`;
  for (let directory = 0; directory < 12; directory++) {
    const folder = path.join(repo, `module-${directory}`);
    await fs.mkdir(folder, { recursive: true });
    const pending = [];
    for (let i = 0; i < 75; i++) {
      const index = directory * 75 + i;
      const contents = common + (index % 31 === 0 ? "rare_needle is here\n" : "not a match\n");
      pending.push(fs.writeFile(path.join(folder, `file-${String(index).padStart(4, "0")}.ts`), contents));
    }
    await Promise.all(pending);
  }

  const options = { pattern: "rare_needle", path: repo, glob: "*.ts", headLimit: 200 };
  const js = await measure(options, "deliberately-missing-ripgrep-command");
  assert.equal(js.output.split("\n").length, 30, "fixture should produce 30 matching files");
  console.log(`Fixture: 900 source files; JS fallback: p50=${js.timing.p50}ms p95=${js.timing.p95}ms`);

  if (hasRipgrep) {
    const native = await measure(options, binary);
    const canonical = (value) => value.split("\n").sort().join("\n");
    assert.equal(canonical(native.output), canonical(js.output), "ripgrep and fallback must return the same lines");
    console.log(`ripgrep: p50=${native.timing.p50}ms p95=${native.timing.p95}ms`);
  } else {
    console.log("ripgrep unavailable; native benchmark skipped");
  }

  const fixture = { path: repo, output: js.output };
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  const slim = toolResult("grep", fixture);
  process.env.CHATGPT_TOOL_PROFILE = "full";
  const full = toolResult("grep", fixture);
  console.log(`MCP text size: slim=${Buffer.byteLength(slim.content[0].text)}B full=${Buffer.byteLength(full.content[0].text)}B`);
  assert.deepEqual(slim.structuredContent, full.structuredContent);
} finally {
  if (previousRg === undefined) delete process.env.LOCAL_CODER_RG_BIN;
  else process.env.LOCAL_CODER_RG_BIN = previousRg;
  if (previousProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = previousProfile;
  await fs.rm(temporary, { recursive: true, force: true });
}