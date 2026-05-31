import { generateText, stepCountIs } from "ai";
import { getChatModel } from "../../ai";
import { createPlaywrightMCP } from "../mcp-client";
import type { HeadlessContext } from "../../pipelines/context";

/**
 * Exploratory Agent: Planner (headless)
 *
 * Ported from the source regression planner. Changes for headless operation:
 *   - The source opened a VISIBLE Chromium (headless:false) and narrated to a
 *     UI. This spawns a per-task HEADLESS + isolated MCP browser instead and
 *     tears it down in `finally`. `createPlaywrightMCP()` returns `{ tools,
 *     close }` with `tools` already resolved — used directly.
 *   - `ctx.emit(...)` replaced with `ctx.log(stage, message)`.
 *   - The plan-approval loop and `regeneratePlan` are removed (fully autonomous).
 *
 * Explores `ctx.targetUrl`, auto-logs in with stored credentials, and returns a
 * markdown test plan.
 */
export async function runPlanner(ctx: HeadlessContext): Promise<string> {
  ctx.log("planner", "Launching headless Chromium via per-task Playwright MCP...");

  const mcp = await createPlaywrightMCP();

  try {
    const tools = mcp.tools;

    ctx.log(
      "planner",
      `Browser ready. ${Object.keys(tools).length} tools available. Exploring ${ctx.targetUrl}...`
    );

    // Phase 1: AI-driven browser exploration
    const explorationResult = await generateText({
      model: await getChatModel(),
      tools,
      stopWhen: stepCountIs(30),
      system: `You are a senior QA test planner controlling a live Chromium browser through Playwright MCP tools. Your task is to thoroughly explore a web application page and discover all testable scenarios.

WORKFLOW:
1. Navigate to the target URL provided
2. If the application requires login, use the credentials below to authenticate first
3. Use browser_snapshot to understand page structure before each interaction
4. Systematically explore ALL interactive elements on the page:
   - Forms and inputs
   - Buttons and links
   - Dropdowns and menus
   - Modals and dialogs
   - Navigation elements
   - Data display areas (tables, lists, cards)
5. For each element, note what it does, what happens when you interact with it
6. Test edge cases: empty inputs, invalid data, boundary conditions
7. Note any loading states, error messages, or validation feedback

CREDENTIALS (use if login is required):
- Username: ${ctx.applicationUsername}
- Password: ${ctx.applicationPassword}

IMPORTANT:
- Always use browser_snapshot before interactions to get accurate element references
- Be thorough — explore every section of the page
- Note the exact selectors and text for each element you find
- Do NOT generate test code — just explore and understand the page
- After exploring, you'll generate a test plan in the next phase`,
      prompt: `Application: ${ctx.applicationName}
Target URL to explore: ${ctx.targetUrl}`,
      onStepFinish: ({ text, toolCalls }) => {
        if (text) {
          ctx.log("planner", text);
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            const inputStr = JSON.stringify(
              "input" in tc ? tc.input : {},
              null,
              0
            ).slice(0, 200);
            ctx.log("planner", `${tc.toolName}(${inputStr})`);
          }
        }
      },
    });

    ctx.log(
      "planner",
      `Exploration complete (${explorationResult.steps.length} steps). Generating test plan...`
    );

    // Phase 2: Generate markdown test plan from exploration
    const actionLog = explorationResult.steps
      .map((step, i) => {
        const parts: string[] = [];
        if (step.text) parts.push(`Thinking: ${step.text}`);
        if (step.toolCalls && step.toolResults) {
          for (let j = 0; j < step.toolCalls.length; j++) {
            const tc = step.toolCalls[j];
            const tr = step.toolResults[j];
            const inputStr = JSON.stringify("input" in tc ? tc.input : {});
            const outputStr = JSON.stringify(
              tr && "output" in tr ? tr.output : "no result"
            ).slice(0, 500);
            parts.push(`Tool: ${tc.toolName}(${inputStr}) => ${outputStr}`);
          }
        }
        return `Step ${i + 1}:\n${parts.join("\n")}`;
      })
      .join("\n\n");

    const { text: testPlan } = await generateText({
      model: await getChatModel(),
      system: `You are a QA test plan architect. Convert a browser exploration log into a comprehensive, structured markdown test plan.

FORMAT:
# Test Plan: [Page/Feature Name]

## Overview
Brief description of what was explored and the test coverage.

## Test Scenarios

### Scenario 1: [Descriptive Name]
**Objective:** What this test verifies
**Steps:**
1. Navigate to [URL]
2. [Specific action with exact element description]
3. [Specific action]
**Expected Results:**
- [Specific assertion 1]
- [Specific assertion 2]

### Scenario 2: [Descriptive Name]
...

## Edge Cases
- [Edge case 1]
- [Edge case 2]

REQUIREMENTS:
- Be specific about element selectors, text content, and expected values
- Include both positive and negative test scenarios
- Cover form validations, error states, and success states
- Each scenario must be self-contained and independently executable
- Include login/authentication steps where needed
- Reference actual URLs, button text, and field labels found during exploration
- Output ONLY the markdown plan, no code fences wrapping it`,
      prompt: `Application: ${ctx.applicationName}
Target URL: ${ctx.targetUrl}

Browser Exploration Log:
${actionLog}`,
    });

    return testPlan.replace(/^```(?:markdown)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  } finally {
    await mcp.close();
  }
}
