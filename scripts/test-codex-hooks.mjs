import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCodexHook } from "../dist/lib/codex-hooks.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-hooks-qa-"));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`OK  ${name}`);
}

try {
  await test("hook preserves successful JSON context", async () => {
    const output = await runCodexHook({
      command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'ready'}}))"`,
      timeout_ms: 5000,
    });
    assert.equal(output, "ready");
  });

  await test("hook output remains bounded while retaining the latest text", async () => {
    const output = await runCodexHook({
      command: `node -e "process.stdout.write('X'.repeat(300000)+'END')"`,
      timeout_ms: 5000,
    });
    assert.ok(output.length <= 64 * 1024, `unbounded hook output: ${output.length}`);
    assert.ok(output.endsWith("END"), "latest hook output should be preserved");
  });

  await test("hook timeout terminates descendants before their delayed write", async () => {
    const marker = path.join(root, "late-marker.txt");
    const child = path.join(root, "late-child.cjs");
    const parent = path.join(root, "late-parent.cjs");
    await fs.writeFile(child, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1100);\n`);
    await fs.writeFile(parent, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], {stdio:'ignore',windowsHide:true}); setTimeout(() => {}, 5000);\n`);
    const output = await runCodexHook({ command: `node ${JSON.stringify(parent)}`, timeout_ms: 350 });
    assert.equal(output, "");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  });

  console.log(`\n${passed} passed, 0 failed`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}