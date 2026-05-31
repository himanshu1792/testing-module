import { generateText } from "ai";
import { getChatModel } from "../ai";
import type { HeadlessContext } from "../pipelines/context";
import { runAutoGate } from "../auto-gate";

/**
 * Agent: Prompt Builder (headless)
 *
 * Ported from the source `buildPromptWithAI`. The human approval loop
 * (`requestPromptApproval`) and the upstream analyst/clarifications step are
 * gone. The structured testing prompt is built directly from the task input
 * plus any ADO acceptance criteria, then run through `runAutoGate`:
 *   - produce:  buildPromptWithAI(ctx, feedback)
 *   - validate: deterministic checks (non-empty, real app URL host present,
 *               numbered steps present, no placeholder hosts like example.com)
 *   - critique: an LLM judge that returns JSON {approved, feedback} deciding
 *               whether the prompt fully covers the scenario AND every
 *               acceptance criterion.
 */
export async function runPromptBuilder(ctx: HeadlessContext): Promise<string> {
  ctx.log("prompt_builder", "Building structured test prompt...");

  const result = await runAutoGate<string>({
    maxAttempts: 3,
    log: (msg) => ctx.log("prompt_builder", msg),
    produce: (feedback) => buildPromptWithAI(ctx, feedback),
    validate: (prompt) => validatePrompt(ctx, prompt),
    critique: (prompt) => critiquePrompt(ctx, prompt),
  });

  if (result.approved) {
    ctx.log("prompt_builder", `Prompt approved after ${result.attempts} attempt(s). Proceeding to script generation.`);
  } else {
    ctx.log(
      "prompt_builder",
      `Proceeding with best-effort prompt after ${result.attempts} attempt(s) (auto-gate not fully satisfied).`
    );
  }

  return result.value;
}

/** Generate the structured test prompt with the source system prompt. */
async function buildPromptWithAI(
  ctx: HeadlessContext,
  feedback: string | null
): Promise<string> {
  const acceptanceCriteriaBlock = ctx.acceptanceCriteria
    ? `\nADO Work Item: "${ctx.acceptanceCriteria.title}"\n${ctx.acceptanceCriteria.criteria}`
    : "";

  const acSystemNote = ctx.acceptanceCriteria
    ? "\nIMPORTANT: Acceptance criteria from the linked ADO work item are provided. Ensure EVERY acceptance criterion is covered by at least one test step with a corresponding assertion. Map each criterion to specific steps in the test prompt."
    : "";

  const feedbackBlock = feedback
    ? `\n\nThe previous prompt was rejected by an automated reviewer with this feedback:\n"${feedback}"\nIncorporate this feedback into the new prompt.`
    : "";

  const { text } = await generateText({
    model: await getChatModel(),
    system: `You are a test prompt engineer. Generate a detailed, structured testing prompt that will guide an AI agent to generate a Playwright test script.

The prompt must include:
1. Clear step-by-step test instructions (numbered)
2. Expected assertions at each step (what to verify)
3. Login/authentication steps if the application requires credentials
4. Element interaction specifics (what to click, fill, verify)
5. Edge cases or negative checks relevant to the scenario
${acSystemNote}
Format the output as a clean Markdown document with numbered steps.
Do NOT include any code — only human-readable instructions for the test generation agent.
Be specific about what pages to visit, what elements to interact with, and what outcomes to verify.

IMPORTANT: The application URL is provided below. Always use EXACTLY this URL as the starting point for navigation. Do NOT use placeholder URLs like "https://example.com" or any other generic URL. The very first step must navigate directly to the provided application URL or a relevant path under it.`,
    prompt: `Application: ${ctx.applicationName}
Application URL (use this exact URL, do NOT substitute with example.com or any placeholder): ${ctx.applicationUrl}

Original Scenario:
${ctx.inputText}
${acceptanceCriteriaBlock}
${feedbackBlock}`,
  });

  // Strip markdown code fences the AI sometimes wraps the output in
  return text.replace(/^```(?:markdown)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

/** Deterministic problems list ([] = clean). */
function validatePrompt(ctx: HeadlessContext, prompt: string): string[] {
  const problems: string[] = [];

  if (!prompt || prompt.trim().length === 0) {
    problems.push("The prompt is empty.");
    // Nothing else is meaningful on an empty prompt.
    return problems;
  }

  // Must reference the real application host (not a placeholder).
  const host = safeHost(ctx.applicationUrl);
  if (host && !prompt.toLowerCase().includes(host.toLowerCase())) {
    problems.push(`The prompt must reference the real application host "${host}" from ${ctx.applicationUrl}.`);
  }

  // Forbid common placeholder hosts.
  if (/example\.com/i.test(prompt)) {
    problems.push('The prompt must not use the placeholder URL "example.com".');
  }

  // Require numbered steps (e.g. "1." / "1)").
  if (!/(^|\n)\s*1[.)]/.test(prompt)) {
    problems.push("The prompt must contain numbered steps (a step starting with '1.').");
  }

  return problems;
}

/** LLM judge: returns {approved, feedback}. */
async function critiquePrompt(
  ctx: HeadlessContext,
  prompt: string
): Promise<{ approved: boolean; feedback: string }> {
  const acceptanceCriteriaBlock = ctx.acceptanceCriteria
    ? `\nAcceptance criteria that MUST each be covered by at least one step + assertion:\n"${ctx.acceptanceCriteria.title}"\n${ctx.acceptanceCriteria.criteria}`
    : "\n(No acceptance criteria were provided.)";

  const { text } = await generateText({
    model: await getChatModel(),
    system: `You are a strict QA reviewer judging whether a test prompt is ready to drive Playwright test generation.

Approve ONLY if the prompt:
- Fully covers the described scenario end-to-end with numbered steps.
- Includes a verification/assertion for each meaningful step.
- Covers EVERY provided acceptance criterion (if any) with a corresponding step + assertion.
- Uses the exact provided application URL as the entry point and contains no placeholder URLs.
- Includes login steps if credentials/authentication are implied.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"approved": boolean, "feedback": "specific, actionable gaps to fix; empty string if approved"}`,
    prompt: `Application: ${ctx.applicationName}
Application URL: ${ctx.applicationUrl}

Scenario:
${ctx.inputText}
${acceptanceCriteriaBlock}

PROMPT UNDER REVIEW:
${prompt}`,
  });

  return parseJudgement(text);
}

function parseJudgement(text: string): { approved: boolean; feedback: string } {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { approved?: unknown; feedback?: unknown };
    return {
      approved: parsed.approved === true,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch {
    // Heuristic fallback: only approve on an explicit, unambiguous signal.
    const approved = /"approved"\s*:\s*true/i.test(cleaned);
    return { approved, feedback: approved ? "" : cleaned.slice(0, 500) };
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
