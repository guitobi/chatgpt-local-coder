import assert from "node:assert/strict";
import { toolResult, toolError } from "../dist/lib/tool-result.js";

const savedProfile = process.env.CHATGPT_TOOL_PROFILE;

try {
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  const payload = { path: "sample.ts", content: "A long body that should not appear twice" };
  const chat = toolResult("read_text_file", payload, { summary: "read completed" });
  assert.equal(chat.content[0].text, "read completed", "slim content must not repeat structured data");
  assert.deepEqual(chat.structuredContent.data, payload);
  assert.equal(chat.structuredContent.summary, "read completed");

  const failed = toolError("write_file", "Permission denied", { path: "protected.ts" });
  assert.equal(failed.structuredContent.ok, false);
  assert.match(failed.content[0].text, /Permission denied/);
  assert.deepEqual(failed.structuredContent.data, { error: "Permission denied", path: "protected.ts" });

  process.env.CHATGPT_TOOL_PROFILE = "focused";
  const focused = toolResult("read_text_file", payload, { summary: "read completed" });
  assert.equal(focused.content[0].text, "read completed", "focused must not duplicate the structured payload as JSON text");
  assert.deepEqual(focused.structuredContent, chat.structuredContent);

  process.env.CHATGPT_TOOL_PROFILE = "full";
  const generic = toolResult("read_text_file", payload, { summary: "read completed" });
  assert.deepEqual(JSON.parse(generic.content[0].text), generic.structuredContent);
  assert.deepEqual(generic.structuredContent, chat.structuredContent);
  console.log("tool-result: 4 passed, 0 failed");
} finally {
  if (savedProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = savedProfile;
}