import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (!process.env.MCP_TEST_URL) throw new Error("MCP_TEST_URL is required");
const endpoint = new URL(process.env.MCP_TEST_URL);
if (!["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
  throw new Error("Container smoke test requires a loopback-only endpoint");
}
const healthResponse = await fetch(new URL("/health", endpoint));
if (!healthResponse.ok || (await healthResponse.json()).workspace !== "/workspace") {
  throw new Error("Refusing to modify a server outside the disposable /workspace fixture");
}

const client = new Client({ name: "isolated-container-check", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_TEST_URL)));
  const write = await client.callTool({
    name: "write_file",
    arguments: { path: "/workspace/sample.ts", content: "const CHECK = 1;\n" },
  });
  assert.equal(write.structuredContent?.ok, true);

  const inspected = await client.callTool({
    name: "inspect_code",
    arguments: { path: "/workspace", query: "CHECK" },
  });
  assert.equal(inspected.structuredContent?.ok, true);
  assert.equal(inspected.structuredContent?.data?.matches?.length, 1);

  const edited = await client.callTool({
    name: "edit_and_verify",
    arguments: {
      path: "/workspace/sample.ts",
      patch: "@@\n-const CHECK = 1;\n+const CHECK = 2;",
      working_directory: "/workspace",
      command: "node -p \"require('fs').readFileSync('sample.ts','utf8').includes('CHECK = 2')\"",
    },
  });
  assert.equal(edited.structuredContent?.data?.patch_applied, true);
  if (edited.structuredContent?.data?.verification?.exit_code !== 0) {
    console.error(JSON.stringify(edited.structuredContent?.data).slice(0, 3000));
  }
  assert.equal(edited.structuredContent?.data?.verification?.exit_code, 0);
  assert.equal(edited.structuredContent?.data?.ok, true);
  console.log("OK  container MCP write, inspect, edit and verification");
} finally {
  await client.close().catch(() => {});
}