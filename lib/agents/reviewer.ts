import { generateText } from "ai";
import { getChatModel } from "../ai";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HeadlessContext } from "../pipelines/context";

const execFileAsync = promisify(execFile);
const MAX_RETRIES = 3;

interface RunResult {
  passed: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Execute a Playwright test script in headless mode.
 * Writes the script to a temp file, runs it via npx playwright test,
 * and captures stdout/stderr.
 */
async function executeScript(
  scriptContent: string,
  username: string,
  password: string
): Promise<RunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "testforge-"));
  const scriptPath = join(tempDir, "test.spec.ts");

  try {
    await writeFile(scriptPath, scriptContent, "utf-8");

    const result = await execFileAsync(
      "npx",
      [
        "playwright",
        "test",
        scriptPath,
        "--reporter=line",
        "--timeout=30000",
      ],
      {
        timeout: 90_000,
        env: {
          ...process.env,
          TEST_USERNAME: username,
          TEST_PASSWORD: password,
        },
      }
    ).catch((error: { stdout?: string; stderr?: string; message?: string }) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
    }));

    const output = `${result.stdout}\n${result.stderr}`;
    const passed =
      !output.includes("failed") &&
      !output.includes("Error") &&
      !output.includes("FAIL");

    return {
      passed,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

/**
 * Agent: Reviewer (headless)
 *
 * Runs the generated script in headless Chromium, captures errors, and uses AI
 * to diagnose + auto-fix. Retries up to MAX_RETRIES.
 *
 * Headless change: on FINAL failure it does NOT throw. The pipeline must always
 * reach PR creation autonomously — a human reviews the PR afterward — so the
 * best-effort script is returned with a logged warning.
 */
export async function runReviewer(
  ctx: HeadlessContext,
  script: string
): Promise<string> {
  ctx.log("reviewer", "Reviewing generated script...");

  let currentScript = script;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    ctx.log(
      "reviewer",
      attempt === 1
        ? "Running script in headless Chromium..."
        : `Re-running script (attempt ${attempt}/${MAX_RETRIES})...`
    );

    const result = await executeScript(
      currentScript,
      ctx.applicationUsername,
      ctx.applicationPassword
    );

    if (result.passed) {
      ctx.log("reviewer", "Script passed all checks. No errors found.");
      return currentScript;
    }

    // Script failed — use AI to diagnose and fix
    ctx.log("reviewer", `Script failed (attempt ${attempt}). Analyzing errors and attempting auto-fix...`);

    const errorOutput = [
      "STDOUT:",
      result.stdout.slice(0, 2000),
      "",
      "STDERR:",
      result.stderr.slice(0, 2000),
    ].join("\n");

    if (result.stderr.trim()) {
      ctx.log("reviewer", `Error: ${result.stderr.slice(0, 200)}`);
    }

    const { text: fixedScript } = await generateText({
      model: await getChatModel(),
      system: `You are a Playwright test debugging expert. Analyze the test script and its error output, then produce a corrected version of the entire script.

RULES:
- Fix the specific errors shown in the output
- Common fixes: wrong selectors, missing waits, incorrect assertions, timeout issues
- Keep the overall test structure intact
- Use more robust selectors if the current ones fail (data-testid, aria-label, role)
- Add waitForSelector or waitForLoadState if there are timing issues
- Ensure credentials use process.env.TEST_USERNAME and process.env.TEST_PASSWORD
- Output ONLY the corrected script — no explanations, no markdown fencing`,
      prompt: `CURRENT SCRIPT:
${currentScript}

ERROR OUTPUT:
${errorOutput}

APPLICATION URL: ${ctx.applicationUrl}

Fix this script and return the corrected version.`,
    });

    ctx.log("reviewer", "Applied fixes. Will re-run to verify.");

    currentScript = fixedScript
      .replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }

  // All retries exhausted — best-effort, do NOT throw.
  ctx.log(
    "reviewer",
    `WARNING: Script did not pass review after ${MAX_RETRIES} attempts. Proceeding with best-effort script; the resulting PR should be reviewed manually.`
  );
  return currentScript;
}
