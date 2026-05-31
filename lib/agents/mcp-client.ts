import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

/**
 * Per-task Playwright MCP lifecycle.
 *
 * Unlike a long-lived singleton, every pipeline run spawns its OWN
 * @playwright/mcp child process and tears it down in a `finally` block. This is
 * the memory-safe pattern for running many tests at scale:
 *
 *   - `--headless`  : no visible window (this is a background worker)
 *   - `--isolated`  : ephemeral in-memory browser profile, discarded on exit
 *   - per-task spawn: a crash/leak in one run can't pollute the next
 *
 * `close()` ends the stdio channel, which terminates the child MCP server and
 * with it the Chromium context. It is raced against a timeout so a hung
 * shutdown can never wedge a worker slot.
 */

export interface PlaywrightMCP {
  tools: Awaited<ReturnType<MCPClient["tools"]>>;
  close: () => Promise<void>;
}

const require = createRequire(import.meta.url);

/** Resolve @playwright/mcp's cli.js without depending on the process CWD. */
function resolveMcpCli(): string {
  const pkgJson = require.resolve("@playwright/mcp/package.json");
  return join(dirname(pkgJson), "cli.js");
}

const CLOSE_TIMEOUT_MS = 5000;

export async function createPlaywrightMCP(): Promise<PlaywrightMCP> {
  const client = await createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command: process.execPath, // current node binary
      args: [
        resolveMcpCli(),
        "--browser=chromium",
        "--headless",
        "--isolated",
        "--caps=testing",
      ],
    }),
  });

  let tools: Awaited<ReturnType<MCPClient["tools"]>>;
  try {
    tools = await client.tools();
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
  };

  return { tools, close };
}
