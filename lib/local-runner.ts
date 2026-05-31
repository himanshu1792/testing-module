import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, writeFile, unlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * Local headed test runner.
 *
 * Runs a single generated @playwright/test spec in a VISIBLE browser window so
 * a user can watch it execute, streaming each output line back as it appears.
 *
 * Unlike the headless reviewer (lib/agents/reviewer.ts), which buffers all
 * output and parses it after the run, this:
 *   - runs HEADED (use.headless = false) so the window is shown,
 *   - streams stdout/stderr line-by-line via `onLine`,
 *   - is cancellable mid-run via an AbortSignal (kills the child + browser).
 *
 * Two environment realities shape how we launch (both discovered empirically on
 * the target Windows machine and verified):
 *
 *   1. CLI identity. The repo has a version-skewed Playwright tree: a top-level
 *      `playwright` (alpha, pulled transitively by @playwright/mcp) AND
 *      `@playwright/test` at a different version. Generated specs
 *      `import { test } from "@playwright/test"`, so the runner MUST launch
 *      @playwright/test's OWN cli.js — launching the top-level `playwright`
 *      cli.js makes the runtimes disagree ("two different versions of
 *      @playwright/test", zero tests run). We resolve via its package.json
 *      because the package `exports` map blocks resolving cli.js directly.
 *
 *   2. Browser channel. @playwright/test's bundled Chrome-for-Testing build
 *      fails to start on this machine with a side-by-side/VC++ runtime error
 *      ("spawn UNKNOWN"). The user's installed Edge (Chromium-based, correct
 *      runtime) launches cleanly, so we drive it via `use.channel`. The channel
 *      is overridable with TESTFORGE_RUN_CHANNEL — set it to "chromium" (or
 *      "bundled") to use Playwright's bundled browser instead, or to another
 *      channel name such as "chrome".
 *
 * There is no playwright.config in the project, so we write a throwaway config
 * next to the temp spec (the `test` CLI has no --channel flag) and point the CLI
 * at it with --config.
 */

export interface RunLineEvent {
  stream: "stdout" | "stderr";
  line: string;
}

export interface HeadedRunResult {
  exitCode: number;
  passed: boolean;
}

const require = createRequire(import.meta.url);

/**
 * Resolve @playwright/test's cli.js without depending on the process CWD.
 * NOTE: resolve the package.json (which IS exported) and join to cli.js — the
 * package `exports` map blocks resolving "cli.js" as a subpath directly.
 */
function resolvePlaywrightTestCli(): string {
  const pkgJson = require.resolve("@playwright/test/package.json");
  return join(dirname(pkgJson), "cli.js");
}

/**
 * Browser channel to drive, from TESTFORGE_RUN_CHANNEL (defaults to "msedge").
 * Returns null to mean "use Playwright's bundled browser" (no channel).
 */
function resolveChannel(): string | null {
  const raw = (process.env.TESTFORGE_RUN_CHANNEL ?? "msedge").trim();
  const lowered = raw.toLowerCase();
  if (raw === "" || lowered === "chromium" || lowered === "bundled") return null;
  return raw;
}

/** Build the throwaway Playwright config that runs our one temp spec headed. */
function buildConfigSource(): string {
  const channel = resolveChannel();
  const use: Record<string, unknown> = { headless: false };
  if (channel) use.channel = channel;
  const config = { testDir: ".", timeout: 60_000, use };
  // JSON.stringify yields a valid TS object literal (keys quoted) — no escaping
  // pitfalls from interpolating a channel name into source.
  return `export default ${JSON.stringify(config, null, 2)};\n`;
}

/** Overall safety timeout so a wedged run can never leak a process. */
const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

export async function runScriptHeaded(opts: {
  script: string;
  username: string;
  password: string;
  signal?: AbortSignal;
  onLine: (ev: RunLineEvent) => void;
}): Promise<HeadedRunResult> {
  const { script, username, password, signal, onLine } = opts;

  const cliPath = resolvePlaywrightTestCli();
  // The temp spec/config MUST live inside the project tree: the spec's
  // `import { test } from "@playwright/test"` is resolved by Node walking up
  // from the spec's directory, so a spec written to the OS temp dir (no
  // node_modules above it) fails with "Cannot find module '@playwright/test'".
  // `.testforge-runs/` is git-ignored and excluded from tsconfig.
  const base = join(process.cwd(), ".testforge-runs");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "run-"));
  const scriptPath = join(dir, "test.spec.ts");
  const configPath = join(dir, "runner.config.ts");
  await writeFile(scriptPath, script, "utf-8");
  await writeFile(configPath, buildConfigSource(), "utf-8");

  return new Promise<HeadedRunResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "test",
        "--config",
        configPath,
        "--workers=1",
        "--reporter=line",
      ],
      {
        // Run from the project root so @playwright/test + its browsers resolve.
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_USERNAME: username,
          TEST_PASSWORD: password,
        },
      }
    );

    // --- Line buffering: split each stream on \n, emit complete lines,
    // flush any trailing partial line when that stream ends. ---
    const makeLineReader = (stream: "stdout" | "stderr") => {
      let buffer = "";
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf-8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          onLine({ stream, line });
        }
      };
      const flush = (): void => {
        if (buffer.length > 0) {
          onLine({ stream, line: buffer.replace(/\r$/, "") });
          buffer = "";
        }
      };
      return { onData, flush };
    };

    const stdoutReader = makeLineReader("stdout");
    const stderrReader = makeLineReader("stderr");
    child.stdout?.on("data", stdoutReader.onData);
    child.stderr?.on("data", stderrReader.onData);

    // --- Cancellation + safety timeout: both kill the child (which tears down
    // the browser). Guard against double-handling after close. ---
    let settled = false;

    const safetyTimer = setTimeout(() => {
      child.kill();
    }, SAFETY_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill();
    };
    if (signal) {
      if (signal.aborted) {
        child.kill();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const cleanup = async (): Promise<void> => {
      clearTimeout(safetyTimer);
      signal?.removeEventListener("abort", onAbort);
      await unlink(scriptPath).catch(() => {});
      await unlink(configPath).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      // Settle only after temp files are removed, so a run dir can never leak
      // even if the caller exits immediately on the returned promise.
      void cleanup().finally(() => reject(err));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stdoutReader.flush();
      stderrReader.flush();
      void cleanup().finally(() =>
        resolve({ exitCode: code ?? -1, passed: code === 0 })
      );
    });
  });
}
