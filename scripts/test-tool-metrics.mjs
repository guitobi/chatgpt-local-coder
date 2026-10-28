import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-metrics-"));
const saved = {
  metrics: process.env.LOCAL_CODER_METRICS,
  audit: process.env.AUDIT_LOG_PATH,
  profile: process.env.CHATGPT_TOOL_PROFILE,
  admin: process.env.ADMIN_TOKEN,
  cwd: process.cwd(),
};
let mcpServer;
let client;
let httpServer;

try {
  process.env.AUDIT_LOG_PATH = path.join(temp, "audit.log");
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  delete process.env.LOCAL_CODER_METRICS;
  process.chdir(temp);

  const { recordToolMetric, getToolMetricsSnapshot } = await import("../dist/lib/tool-metrics.js");

  const privateData = "PRIVATE_METRICS_FIXTURE_NEVER_LOG";
  let serializedWhileDisabled = false;
  recordToolMetric("off_test", 17, {
    toJSON: () => { serializedWhileDisabled = true; return { privateData }; },
  });
  assert.equal(serializedWhileDisabled, false, "disabled telemetry must not serialize tool responses");
  assert.deepEqual(getToolMetricsSnapshot(), { enabled: false, tools: [] });

  process.env.LOCAL_CODER_METRICS = "1";
  const toolName = "aggregate_test";
  recordToolMetric(toolName, 4, { structuredContent: { ok: true, data: { privateData } } });
  recordToolMetric(toolName, 8, { structuredContent: { ok: false, data: { privateData } } });
  recordToolMetric(toolName, 12, undefined, true);
  for (let i = 0; i < 300; i++) {
    recordToolMetric("bounded_test", i, { content: [{ type: "text", text: privateData }] });
  }

  const unit = getToolMetricsSnapshot();
  const aggregate = unit.tools.find((row) => row.name === toolName);
  const bounded = unit.tools.find((row) => row.name === "bounded_test");
  assert.equal(aggregate.calls, 3);
  assert.equal(aggregate.errors, 2);
  assert.equal(aggregate.latency_ms.p50, 8);
  assert.equal(aggregate.latency_ms.p95, 12);
  assert.ok(aggregate.response_bytes.p50 > 0);
  assert.equal(bounded.calls, 300);
  assert.ok(bounded.sample_count <= 256);
  assert.deepEqual(Object.keys(aggregate).sort(), ["calls", "errors", "latency_ms", "name", "response_bytes", "sample_count"].sort());
  assert.doesNotMatch(JSON.stringify(unit), /PRIVATE_METRICS_FIXTURE_NEVER_LOG|off_test|audit.log/);

  const { createMcpServer } = await import("../dist/server-factory.js");
  const filePath = path.join(temp, "private-input.ts");
  await fs.writeFile(filePath, "const token = '" + privateData + "';\n");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcpServer = createMcpServer(temp, 20);
  mcpServer.registerTool("qa__throws", {
    description: "Synthetic exception coverage for QA metrics",
    inputSchema: {},
  }, async () => { throw new Error("synthetic callback error"); });
  await mcpServer.connect(serverSide);
  client = new Client({ name: "metrics-test", version: "0.1" });
  await client.connect(clientSide);

  const ok = await client.callTool({ name: "read_text_file", arguments: { path: filePath } });
  assert.equal(ok.structuredContent?.ok, true);
  const failed = await client.callTool({ name: "read_text_file", arguments: { path: path.join(temp, "missing.ts") } });
  assert.ok(failed.isError === true || failed.structuredContent?.ok === false);
  try {
    await client.callTool({ name: "qa__throws", arguments: {} });
  } catch {
    // The SDK is allowed to turn handler exceptions into a JSON-RPC rejection.
  }

  const observed = getToolMetricsSnapshot().tools.find((row) => row.name === "read_text_file");
  assert.ok(observed, "MCP-registered callbacks must be measured");
  assert.equal(observed.calls, 2);
  assert.equal(observed.errors, 1);
  assert.ok(observed.latency_ms.p95 >= observed.latency_ms.p50);
  assert.ok(observed.response_bytes.p95 > 0);
  assert.doesNotMatch(JSON.stringify(getToolMetricsSnapshot()), /PRIVATE_METRICS_FIXTURE_NEVER_LOG|private-input|missing.ts/);
  const thrown = getToolMetricsSnapshot().tools.find((row) => row.name === "qa__throws");
  assert.equal(thrown?.calls, 1);
  assert.equal(thrown?.errors, 1);

  const { createAdminRouter } = await import("../dist/admin/routes.js");
  const { adminAuth, localhostOnly } = await import("../dist/admin/localhost-guard.js");
  const app = express();
  app.use(localhostOnly);
  app.use(adminAuth);
  app.use(createAdminRouter({}, { mcpPort: 0, pid: process.pid, sessionCount: () => 0 }));
  delete process.env.ADMIN_TOKEN;
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port + "/api/tool-metrics";
  const unconfigured = await fetch(url);
  assert.equal(unconfigured.status, 503, "telemetry must fail closed without ADMIN_TOKEN");
  process.env.ADMIN_TOKEN = "synthetic-local-admin-token";
  const forbidden = await fetch(url);
  assert.equal(forbidden.status, 401);
  const permitted = await fetch(url, { headers: { Authorization: "Bearer synthetic-local-admin-token" } });
  assert.equal(permitted.status, 200);
  const body = await permitted.json();
  assert.equal(body.enabled, true);
  assert.ok(body.tools.some((row) => row.name === "read_text_file"));
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_METRICS_FIXTURE_NEVER_LOG|private-input|missing.ts/);

  console.log("tool-metrics: opt-in, aggregate, bounded, MCP instrumentation, local-admin auth, privacy passed");
} finally {
  await client?.close().catch(() => {});
  await mcpServer?.close().catch(() => {});
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  process.chdir(saved.cwd);
  for (const [key, name] of [
    ["metrics", "LOCAL_CODER_METRICS"],
    ["audit", "AUDIT_LOG_PATH"],
    ["profile", "CHATGPT_TOOL_PROFILE"],
    ["admin", "ADMIN_TOKEN"],
  ]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  await fs.rm(temp, { recursive: true, force: true });
}