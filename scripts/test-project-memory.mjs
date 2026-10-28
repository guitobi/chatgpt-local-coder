/**
 * Test instruction context builder (Phase 1+2).
 * Run: node scripts/test-project-memory.mjs
 */
import {
  buildInstructionContext,
  summarizeInstructionContext,
} from "../dist/lib/instruction-context.js";

const workspaceRoot = process.env.WORKSPACE_PATH || process.cwd();
let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}
function fail(name, err) {
  console.error(`FAIL ${name}: ${err}`);
  failed++;
}

try {
  const ctx = await buildInstructionContext({
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    pid: process.pid,
    adminPort: 3001,
  });

  if (!ctx.instructionsText.includes("Agent workflow")) {
    throw new Error("missing agent prompt");
  }
  ok("agent prompt in instructions");

  if (!ctx.instructionsText.includes("edit_and_verify") ||
      !ctx.instructionsText.includes('command_mode="argv"') ||
      !ctx.instructionsText.includes("without shell syntax")) {
    throw new Error("agent prompt must explain the one-call edit and direct-argv verification path");
  }
  ok("agent prompt gives the model direct-argv edit-and-verify guidance");

  if (!ctx.instructionsText.includes("## Environment")) {
    throw new Error("missing environment block");
  }
  ok("environment block");

  if (!ctx.instructionsText.includes("## Git")) {
    throw new Error("missing git block");
  }
  ok("git block");

  if (!ctx.instructionsText.includes("agent_status")) {
    throw new Error("missing footer quick pointers");
  }
  ok("footer pointers (agent_status not duplicated in body)");

  if (ctx.instructionBytes < 500) {
    throw new Error(`instructions too small: ${ctx.instructionBytes}`);
  }
  ok(`instruction size ${Math.round(ctx.instructionBytes / 1024)}KB`);

  const summary = summarizeInstructionContext(ctx);
  if (!summary.root) throw new Error("summary missing root");
  ok("summarizeInstructionContext");

  if (summary.tool_profile === "focused") {
    if (!ctx.instructionsText.includes("curated coding tools") || ctx.instructionsText.includes("all tools exposed")) {
      throw new Error("focused profile instruction must describe its reduced tool set accurately");
    }
    ok("focused tool profile is described accurately");
  }

  console.log("\nGit:", ctx.git.is_repo ? ctx.git.branch : "not a repo");
  console.log("Memory files:", ctx.projectMemory.sections.map((s) => s.path).join(", ") || "(none)");
} catch (err) {
  fail("buildInstructionContext", err.message || err);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);