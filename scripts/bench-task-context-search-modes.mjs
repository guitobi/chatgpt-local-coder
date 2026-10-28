import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

// Exploratory comparison on synthetic disposable source trees only.
const root = path.resolve(process.argv[2] || "");
assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
const exec = promisify(execFile);
const common = ["--files-with-matches", "--no-require-git", "--no-messages", "--fixed-strings",
  "--ignore-case", "--max-filesize", "128K", "--ignore-file", path.join(root, ".gitignore"),
  "--type-add", "taskcode:*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,vue,svelte,rb,php,sql,sh,ps1}",
  "--type", "taskcode"];

async function find(terms) {
  try {
    const { stdout } = await exec(process.env.LOCAL_CODER_RG_BIN || "rg",
      [...common, ...terms.flatMap((term) => ["--regexp", term]), "--", root],
      { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

function p(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(1));
}

for (const [name, terms] of Object.entries({
  rare: ["earlyAnchorToken", "lateUniqueOwnerToken", "absentTokenOne", "absentTokenTwo"],
  common: ["genericValue", "lateUniqueOwnerToken", "absentTokenOne", "absentTokenTwo"],
})) {
  const samples = { individual: [], union: [] };
  const lengths = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const methods = cycle % 2 === 0 ? ["individual", "union"] : ["union", "individual"];
    for (const method of methods) {
      const started = performance.now();
      const files = method === "union" ? await find(terms)
        : [...new Set((await Promise.all(terms.map((term) => find([term])))).flat())];
      samples[method].push(performance.now() - started);
      if (method === "union") lengths.push(files.length);
    }
  }
  console.log("BENCH search modes", JSON.stringify({
    name, terms, union_found: lengths[0],
    individual_p50_ms: p(samples.individual.slice(1), 0.5),
    union_p50_ms: p(samples.union.slice(1), 0.5),
    individual_p95_ms: p(samples.individual.slice(1), 0.95),
    union_p95_ms: p(samples.union.slice(1), 0.95),
  }));
}