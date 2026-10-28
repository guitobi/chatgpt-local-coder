import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectCode, diagnoseFailure } from "../dist/lib/harness-operations.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-inspect-"));
let passed = 0;

async function run(name, fn) {
  await fn();
  passed++;
  console.log(`OK  ${name}`);
}

try {
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const alpha = path.join(project, "alpha.ts");
  const beta = path.join(project, "beta.ts");
  await fs.writeFile(alpha, "before\nconst TARGET = 1;\nafter\n", "utf8");
  await fs.writeFile(beta, "const ignored = 0;\nconst TARGET = 2;\n", "utf8");

  await run("finds multiple files and preserves exact source line numbers", async () => {
    const result = await inspectCode({ root: project, query: "TARGET", glob: "*.ts", contextLines: 1 });
    assert.equal(result.matches.length, 2);
    assert.deepEqual(result.matches.map(({ path: file, line }) => [file, line]).sort(), [[alpha, 2], [beta, 2]].sort());
    assert.equal(result.excerpts.length, 2);
    const excerpt = result.excerpts.find(({ path: file }) => file === alpha);
    assert.ok(excerpt);
    assert.equal(excerpt.snippets.length, 1);
    assert.deepEqual(excerpt.snippets[0].lines.map(({ line }) => line), [1, 2, 3]);
    assert.equal(excerpt.snippets[0].lines[1].text, "const TARGET = 1;");
    assert.equal(result.git.available, false);
    assert.equal(result.truncated.matches, false);
  });

  await run("inspect_code omits ignored and credential files and redacts secret-bearing source lines", async () => {
    await fs.writeFile(path.join(project, ".gitignore"), "ignored-target.ts\n");
    await fs.writeFile(path.join(project, "ignored-target.ts"), "const TARGET = 'ignored_fixture_marker';\n");
    await fs.writeFile(path.join(project, ".env"), "API_KEY=private_fixture_marker_TARGET\n");
    await fs.writeFile(path.join(project, "credentials.ts"), "const TARGET = 'credential_fixture_marker';\n");
    await fs.writeFile(path.join(project, "safe-secret.ts"), "const API_KEY = 'source_fixture_marker'; // TARGET\n");
    const result = await inspectCode({ root: project, query: "TARGET" });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("ignored_fixture_marker"), `ignored source content returned; paths: ${result.matches.map((m) => m.path).join(", ")}`);
    assert.ok(!serialized.includes("private_fixture_marker"), "hidden env content returned");
    assert.ok(!serialized.includes("credential_fixture_marker"), "credential-named source returned");
    assert.ok(!serialized.includes("source_fixture_marker"), "secret-bearing source line returned");
    const globbed = await inspectCode({ root: project, query: "TARGET", glob: "*.ts" });
    assert.ok(!JSON.stringify(globbed).includes("ignored_fixture_marker"), "explicit glob bypassed .gitignore");
  });

  await run("inspect_code hides every line of an embedded multiline private key", async () => {
    const file = path.join(project, "embedded.ts");
    await fs.writeFile(file, [
      "const note = 'TARGET public';",
      "-----BEGIN PRIVATE KEY-----",
      "opaque_private_payload_fixture_TARGET",
      "-----END PRIVATE KEY-----",
      "const footer = 'TARGET public';",
    ].join("\n"));
    const result = await inspectCode({ root: file, query: "TARGET", contextLines: 3 });
    const response = JSON.stringify(result);
    assert.ok(result.matches.length >= 2);
    assert.ok(!response.includes("opaque_private_payload_fixture"), "private key body leaked");
  });

  await run("inspect_code rejects an explicit symlink source instead of reading outside", async () => {
    const outside = path.join(root, "external-fixture.ts");
    const link = path.join(project, "linked-fixture.ts");
    await fs.writeFile(outside, "const TARGET = 'outside_fixture_marker';\n");
    try {
      await fs.symlink(outside, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return;
      throw error;
    }
    await assert.rejects(inspectCode({ root: link, query: "TARGET" }), /symlink|unsafe/i);
  });

  await run("bounds minified lines in both matches and excerpts", async () => {
    const large = path.join(project, "large.ts");
    await fs.writeFile(large, `const value = "${"x".repeat(80000)}TARGET";\n`, "utf8");
    const result = await inspectCode({ root: large, query: "TARGET", maxMatches: 1, contextLines: 0 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].line, 1);
    assert.equal(result.matches[0].truncated, true);
    assert.ok(result.matches[0].text.includes("TARGET"), "a clipped match must retain matching evidence");
    assert.equal(result.excerpts.length, 1);
    assert.equal(result.excerpts[0].snippets[0].lines[0].truncated, true);
    assert.ok(result.excerpts[0].snippets[0].lines[0].text.includes("TARGET"));
    assert.ok(result.excerpts[0].snippets[0].lines[0].text.endsWith('TARGET";'), "do not mark an uncut suffix as omitted");
    assert.ok(JSON.stringify(result).length < 5000, "response grew with minified source");
  });

  await run("marks match truncation when query finds more than requested limit", async () => {
    const result = await inspectCode({ root: project, query: "TARGET", maxMatches: 1 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.truncated.matches, true);
  });

  await run("merges overlapping context windows without duplicate source lines", async () => {
    const adjacent = path.join(project, "adjacent.ts");
    await fs.writeFile(adjacent, "zero\nTARGET one\nTARGET two\nend\n", "utf8");
    const result = await inspectCode({ root: adjacent, query: "TARGET", contextLines: 1 });
    assert.equal(result.excerpts.length, 1);
    assert.equal(result.excerpts[0].snippets.length, 1);
    assert.deepEqual(result.excerpts[0].snippets[0].lines.map(({ line }) => line), [1, 2, 3, 4]);
  });

  await run("reports missing matches and Git-less directory without failing", async () => {
    const result = await inspectCode({ root: project, query: "NO_SUCH_IDENTIFIER", glob: "*.ts" });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.excerpts, []);
    assert.equal(result.git.available, false);
  });

  await run("limits excerpts to five distinct files and reports overflow", async () => {
    const many = path.join(root, "many");
    await fs.mkdir(many);
    for (let i = 0; i < 7; i++) {
      await fs.writeFile(path.join(many, `f${i}.ts`), `const TARGET = ${i};\n`, "utf8");
    }
    const result = await inspectCode({ root: many, query: "TARGET", maxMatches: 50, contextLines: 5 });
    assert.equal(result.matches.length, 7);
    assert.equal(result.excerpts.length, 5);
    assert.equal(result.truncated.files, true);
  });

  await run("returns bounded Git status when repository is available", async () => {
    const gitRoot = path.join(root, "git-project");
    await fs.mkdir(gitRoot);
    execFileSync("git", ["init", "-q", gitRoot], { windowsHide: true });
    await fs.writeFile(path.join(gitRoot, "source.ts"), "const TARGET = 1;\n", "utf8");
    const result = await inspectCode({ root: gitRoot, query: "TARGET" });
    assert.equal(result.git.available, true);
    assert.ok(result.git.status.some((row) => row.includes("source.ts")));
  });

  await run("diagnoses a successful command with bounded output", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.log('diagnosis-ready')"`,
      maxOutputChars: 256,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.equal(result.stdout.text, "diagnosis-ready");
    assert.equal(result.stderr.text, "");
    assert.deepEqual(result.locations, []);
    assert.equal(result.git.reason, "Skipped after successful command");
  });

  await run("explicit argv verification bypasses shell parsing and preserves a nonzero exit", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: JSON.stringify([process.execPath, "-e", "console.error('src/direct.ts:7:3: error'); process.exit(7)"]),
      commandMode: "argv",
      maxOutputChars: 256,
    });
    assert.equal(result.exit_code, 7);
    assert.equal(result.timed_out, false);
    assert.ok(result.stderr.text.includes("src/direct.ts:7:3: error"));
    assert.ok(result.locations.some((loc) => loc.path === "src/direct.ts" && loc.line === 7 && loc.column === 3));
  });

  await run("retains failing exit code and extracts file:line:column from stderr", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.error('src/example.ts:12:7: failure'); process.exit(7)"`,
    });
    // PowerShell normalizes an external program's nonzero exit to 1;
    // Bash preserves the program's original exit code.
    assert.equal(result.exit_code, process.platform === "win32" ? 1 : 7);
    assert.equal(result.timed_out, false);
    assert.ok(result.stderr.text.includes("src/example.ts:12:7: failure"));
    assert.ok(result.locations.some((loc) => loc.path === "src/example.ts" && loc.line === 12 && loc.column === 7));
    assert.equal(result.git.available, false);
  });

  await run("extracts an absolute Windows error path containing spaces and parentheses", async () => {
    const expected = "D:\\Work Area\\demo (copy)\\task.ts";
    const encoded = Buffer.from(`${expected}:18:3: error`).toString("base64");
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.error(Buffer.from('${encoded}', 'base64').toString())"`,
    });
    assert.ok(result.locations.some((loc) => loc.path === expected && loc.line === 18 && loc.column === 3));
  });

  await run("extracts TypeScript compiler file(line,column) diagnostics", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.error('src/module.ts(11,4): error TS2304')"`,
    });
    assert.ok(result.locations.some((loc) => loc.path === "src/module.ts" && loc.line === 11 && loc.column === 4));
  });

  await run("bounds long logs but still extracts error locations", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.log('X'.repeat(12000)); console.log('src/failure.ts:4:2: error'); process.exit(3)"`,
      maxOutputChars: 128,
    });
    assert.equal(result.exit_code, process.platform === "win32" ? 1 : 3);
    assert.ok(result.stdout.text.length <= 128);
    assert.equal(result.stdout.truncated, true);
    assert.ok(result.locations.some((loc) => loc.path === "src/failure.ts" && loc.line === 4));
  });

  await run("bounds combined stdout and stderr to one shared budget", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.log('X'.repeat(500)); console.error('Y'.repeat(500)); process.exit(1)"`,
      maxOutputChars: 128,
    });
    assert.ok(result.stdout.text.length + result.stderr.text.length <= 128);
    assert.equal(result.stderr.truncated, true);
    assert.equal(result.stdout.truncated, true);
  });

  await run("does not leak huge error paths into structured locations", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.error('C:/' + 'x'.repeat(50000) + '.ts:3:2: error')"`,
      maxOutputChars: 128,
    });
    assert.ok(result.locations.every((loc) => loc.path.length <= 512));
    assert.ok(JSON.stringify(result).length < 2500, "location metadata bypasses log limits");
  });

  await run("reports timeout as timeout rather than a normal exit", async () => {
    const result = await diagnoseFailure({
      root: project,
      command: `node -e "console.log('pre-timeout'); console.error('src/late.ts:9:2: pending'); setTimeout(() => {}, 3000)"`,
      timeoutMs: 900,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.exit_code, null);
    assert.ok(result.stderr.text.toLowerCase().includes("timed out"));
    assert.ok(result.stdout.text.includes("pre-timeout"), "stdout emitted before timeout must survive");
    assert.ok(result.stderr.text.includes("src/late.ts:9:2"), "stderr emitted before timeout must survive");
    assert.ok(result.locations.some((loc) => loc.path === "src/late.ts" && loc.line === 9));
  });

  await run("timeout kills descendants before they can write after the shell exits", async () => {
    const marker = path.join(project, "late-child-marker.txt");
    const childFile = path.join(project, "timeout-child.cjs");
    const parentFile = path.join(project, "timeout-parent.cjs");
    await fs.writeFile(childFile,
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 1200);\n`);
    await fs.writeFile(parentFile,
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(childFile)}], {stdio:"ignore",windowsHide:true}); setTimeout(() => {}, 5000);\n`);
    const result = await diagnoseFailure({
      root: project, command: "node timeout-parent.cjs", timeoutMs: 300,
    });
    assert.equal(result.timed_out, true);
    await new Promise(resolve => setTimeout(resolve, 1800));
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  });

  await run("explicit argv timeout also kills descendants before a delayed write", async () => {
    const marker = path.join(project, "late-argv-marker.txt");
    const childFile = path.join(project, "argv-child.cjs");
    const parentFile = path.join(project, "argv-parent.cjs");
    await fs.writeFile(childFile,
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 1200);\n`);
    await fs.writeFile(parentFile,
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(childFile)}], {stdio:"ignore",windowsHide:true}); setTimeout(() => {}, 5000);\n`);
    const result = await diagnoseFailure({
      root: project, command: JSON.stringify([process.execPath, parentFile]), commandMode: "argv", timeoutMs: 300,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.exit_code, null);
    await new Promise(resolve => setTimeout(resolve, 1800));
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  });

  await run("shell keeps only a bounded tail even before diagnosis formatting", async () => {
    const { execInShellSession } = await import("../dist/lib/persistent-shell.js");
    const result = await execInShellSession(
      `node -e "process.stdout.write('X'.repeat(2000000)+'END')"`,
      project, 10_000, project,
    );
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.length <= 256 * 1024, `captured ${result.stdout.length} unbounded characters`);
    assert.ok(result.stdout.endsWith("END"), "must retain the most recent diagnostics");
  });

  console.log(`\n${passed} passed, 0 failed`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}