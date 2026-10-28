import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-harness-mcp-"));
const originalCwd = process.cwd();
const originalProfile = process.env.CHATGPT_TOOL_PROFILE;
const originalAudit = process.env.AUDIT_LOG_PATH;
let server;
let client;

try {
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  process.env.AUDIT_LOG_PATH = path.join(tmp, "audit.log");
  process.chdir(tmp);
  const { createMcpServer } = await import("../dist/server-factory.js");
  await fs.writeFile(path.join(tmp, "source.ts"), "before\nconst MCP_TARGET = 3;\nafter\n", "utf8");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  server = createMcpServer(tmp, 30);
  await server.connect(serverSide);
  client = new Client({ name: "harness-regression", version: "1.0.0" });
  await client.connect(clientSide);

  const { tools } = await client.listTools();
  const inspector = tools.find((tool) => tool.name === "inspect_code");
  const diagnoser = tools.find((tool) => tool.name === "diagnose_failure");
  const editor = tools.find((tool) => tool.name === "edit_and_verify");
  const taskFinder = tools.find((tool) => tool.name === "task_context");
  assert.ok(inspector, "inspect_code must be advertised in ChatGPT slim profile");
  assert.ok(diagnoser, "diagnose_failure must be advertised in ChatGPT slim profile");
  assert.ok(editor, "edit_and_verify must be advertised in ChatGPT slim profile");
  assert.ok(taskFinder, "task_context must be advertised in ChatGPT slim profile");
  assert.equal(taskFinder.annotations?.readOnlyHint, true);
  assert.equal(inspector.annotations?.readOnlyHint, true);
  assert.equal(diagnoser.annotations?.readOnlyHint, false);
  assert.equal(diagnoser.annotations?.idempotentHint, false);
  assert.equal(editor.annotations?.readOnlyHint, false);
  assert.equal(editor.annotations?.idempotentHint, false);
  assert.ok(inspector.outputSchema?.properties?.data);
  assert.ok(diagnoser.outputSchema?.properties?.data);
  assert.ok(editor.outputSchema?.properties?.data);
  console.log("OK  tools/list exposes correct slim schemas and annotations");

  const { buildServerInstructions } = await import("../dist/lib/quickstart.js");
  const instructions = buildServerInstructions(tmp, [tmp], true);
  assert.match(instructions, /inspect_code/);
  assert.match(instructions, /edit_and_verify/);
  assert.match(instructions, /task_context/);
  assert.match(instructions, /apply_patch.*safe:true/);
  console.log("OK  ChatGPT connector instructions point to the compound and safe tools");

  const inspection = await client.callTool({
    name: "inspect_code",
    arguments: { path: tmp, query: "MCP_TARGET", max_matches: 5, context_lines: 1 },
  });
  assert.equal(inspection.structuredContent?.ok, true);
  assert.equal(inspection.structuredContent?.data?.matches?.length, 1);
  assert.equal(inspection.content?.[0]?.text, inspection.structuredContent?.summary, "slim text is compact");
  console.log("OK  inspect_code works through MCP and returns structured evidence");

  const task = await client.callTool({
    name: "task_context",
    arguments: { path: tmp, task: "Fix MCP_TARGET" },
  });
  assert.equal(task.structuredContent?.ok, true);
  assert.ok(task.structuredContent?.data?.files?.some((file) => file.path.endsWith("source.ts")));
  assert.ok(task.structuredContent?.data?.files?.some((file) => file.lines.some((line) => line.text.includes("MCP_TARGET"))));
  console.log("OK  task_context selects relevant code through MCP without edits");

  const diagnosis = await client.callTool({
    name: "diagnose_failure",
    arguments: { path: tmp, command: `node -e "console.error('src/sample.ts:8:2: failure'); process.exit(3)"` },
  });
  assert.equal(diagnosis.structuredContent?.ok, false);
  assert.notEqual(diagnosis.structuredContent?.data?.exit_code, 0);
  assert.ok(diagnosis.structuredContent?.data?.locations?.some((loc) => loc.path === "src/sample.ts" && loc.line === 8));
  console.log("OK  diagnose_failure preserves failing result over MCP");

  const original = await fs.readFile(path.join(tmp, "source.ts"), "utf8");
  const preview = await client.callTool({
    name: "edit_and_verify",
    arguments: {
      path: path.join(tmp, "source.ts"), patch: "@@\n-const MCP_TARGET = 3;\n+const MCP_TARGET = 4;",
      command: "node -e \"process.exit(17)\"", working_directory: tmp, dry_run: true,
    },
  });
  assert.equal(preview.structuredContent?.ok, true);
  assert.equal(preview.structuredContent?.data?.patch_applied, false);
  assert.equal(preview.structuredContent?.data?.verification_ran, false);
  assert.equal(await fs.readFile(path.join(tmp, "source.ts"), "utf8"), original);

  const changed = await client.callTool({
    name: "edit_and_verify",
    arguments: {
      path: path.join(tmp, "source.ts"), patch: "@@\n-const MCP_TARGET = 3;\n+const MCP_TARGET = 4;",
      command: "node -e \"console.error('src/source.ts:2:1: failed'); process.exit(7)\"",
      working_directory: tmp,
    },
  });
  assert.equal(changed.structuredContent?.ok, false);
  assert.equal(changed.structuredContent?.data?.patch_applied, true);
  assert.equal(changed.structuredContent?.data?.verification_ran, true);
  assert.match(changed.structuredContent?.data?.patch?.checkpoint_id, /^cp_/);
  assert.match(await fs.readFile(path.join(tmp, "source.ts"), "utf8"), /MCP_TARGET = 4/);
  console.log("OK  edit_and_verify over MCP retains patch and checkpoint after test failure");

  const legacy = await client.callTool({
    name: "apply_patch",
    arguments: {
      path: path.join(tmp, "source.ts"), patch: "@@\n-const MCP_TARGET = 4;\n+const MCP_TARGET = 5;", dry_run: true,
    },
  });
  assert.equal(legacy.structuredContent?.ok, true);
  assert.match(legacy.structuredContent?.data?.diff, /MCP_TARGET = 5/);
  assert.equal(legacy.structuredContent?.data?.checkpoint_id, null);
  console.log("OK  legacy single-file apply_patch dry-run still works");

  const log = await fs.readFile(path.join(tmp, "audit.log"), "utf8");
  assert.ok(log.includes('"tool":"inspect_code"'));
  assert.ok(log.includes('"tool":"task_context"'));
  assert.ok(log.includes('"tool":"diagnose_failure"'));
  assert.ok(log.includes('"tool":"edit_and_verify"'));
  console.log("OK  compound tools are audited");

  console.log("\n7 passed, 0 failed");
} finally {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  process.chdir(originalCwd);
  if (originalProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = originalProfile;
  if (originalAudit === undefined) delete process.env.AUDIT_LOG_PATH;
  else process.env.AUDIT_LOG_PATH = originalAudit;
  await fs.rm(tmp, { recursive: true, force: true });
}