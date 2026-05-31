import { generateText, stepCountIs } from "ai";
import { getChatModel } from "../../ai";
import { createPlaywrightMCP } from "../mcp-client";
import type { HeadlessContext } from "../../pipelines/context";

/**
 * Exploratory Agent: Generator (headless)
 *
 * Takes a markdown test plan and generates a Playwright test script. Ported from
 * the source regression generator. Changes for headless operation:
 *   - Uses a per-task HEADLESS + isolated MCP browser (instead of the source's
 *     shared singleton) and closes it in `finally`. `createPlaywrightMCP()`
 *     returns `{ tools, close }` with `tools` already resolved — used directly.
 *   - `ctx.emit(...)` replaced with `ctx.log(stage, message)`.
 */
export async function runGenerator(
  ctx: HeadlessContext,
  testPlan: string
): Promise<string> {
  ctx.log("generator", "Generating Playwright test script from the plan...");

  const mcp = await createPlaywrightMCP();

  try {
    const tools = mcp.tools;

    ctx.log("generator", "Browser tools ready. Converting plan to executable tests...");

    // Phase 1: AI navigates headless browser following the plan to validate selectors
    const validationResult = await generateText({
      model: await getChatModel(),
      tools,
      stopWhen: stepCountIs(25),
      system: `You are a Playwright test automation engineer. You have a test plan and a live headless Chromium browser. Your task is to navigate the application following the test plan and identify the exact selectors for each element mentioned.

WORKFLOW:
1. Navigate to the application URL
2. If login is required, use the credentials below
3. For each scenario in the test plan:
   - Navigate to the relevant page
   - Use browser_snapshot to find the exact selectors for elements mentioned
   - Note the actual selectors (data-testid, aria-label, role, text content)
4. Build a mapping of plan steps to actual selectors

CREDENTIALS:
- Username: ${ctx.applicationUsername}
- Password: ${ctx.applicationPassword}

IMPORTANT:
- Use browser_snapshot before each interaction
- Record exact element references and selectors
- Note any discrepancies between the plan and actual page structure`,
      prompt: `Application: ${ctx.applicationName}
URL: ${ctx.targetUrl}

Test Plan to validate:
${testPlan}`,
      onStepFinish: ({ text, toolCalls }) => {
        if (text) {
          ctx.log("generator", text);
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            ctx.log("generator", `Validating: ${tc.toolName}`);
          }
        }
      },
    });

    ctx.log("generator", "Selector validation complete. Generating test script...");

    // Phase 2: Generate the Playwright test script
    const validationLog = validationResult.steps
      .map((step, i) => {
        const parts: string[] = [];
        if (step.text) parts.push(step.text);
        if (step.toolCalls && step.toolResults) {
          for (let j = 0; j < step.toolCalls.length; j++) {
            const tc = step.toolCalls[j];
            const tr = step.toolResults[j];
            const outputStr = JSON.stringify(
              tr && "output" in tr ? tr.output : "no result"
            ).slice(0, 500);
            parts.push(`${tc.toolName} => ${outputStr}`);
          }
        }
        return `Step ${i + 1}: ${parts.join(" | ")}`;
      })
      .join("\n");

    const { text: script } = await generateText({
      model: await getChatModel(),
      system: `You are a Playwright test script generator. Generate a production-ready Playwright test file from a test plan and validated selectors.

REQUIREMENTS:
- Use import syntax: import { test, expect } from '@playwright/test';
- Use TypeScript/ESM syntax throughout
- Use robust selectors: prefer data-testid, id, aria-label, role over fragile CSS paths
- Include meaningful expect() assertions at key verification points
- Add appropriate waits: waitForSelector, waitForLoadState, waitForURL where needed
- Handle login if the plan includes authentication steps
- DO NOT hardcode credentials — use environment variables:
  process.env.TEST_USERNAME and process.env.TEST_PASSWORD
- Include a descriptive test.describe block
- Create separate test() blocks for each scenario in the plan
- Make tests independent — each test should set up its own state
- Output ONLY the script content, no markdown fencing, no explanations
- Make the script idempotent and repeatable`,
      prompt: `Application: ${ctx.applicationName}
URL: ${ctx.targetUrl}

Test Plan:
${testPlan}

Validated Selectors & Page Structure:
${validationLog}

Generate a complete Playwright test file.`,
    });

    ctx.log("generator", "Test script generated successfully.");

    // Strip markdown code fences that the AI may add despite instructions
    return script
      .replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  } finally {
    await mcp.close();
  }
}
