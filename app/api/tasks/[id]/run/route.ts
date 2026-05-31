import { getTask } from "@/lib/tasks";
import { getApplication } from "@/lib/applications";
import { runScriptHeaded } from "@/lib/local-runner";

/**
 * POST /api/tasks/[id]/run — run a previous run's generated script LOCALLY in a
 * visible (headed) Chromium window, streaming live output back to the client.
 *
 * child_process + a real browser need the Node runtime, and the stream must
 * never be cached or buffered.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-process guard so the same script can't be launched twice concurrently
 * (each launch opens its own browser window). Cleared in the stream's finally.
 */
const RUNNING = new Set<string>();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  // --- Pre-stream validation: plain JSON responses, not the NDJSON stream. ---
  const task = await getTask(id);
  if (!task) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  if (!task.generatedScript || !task.generatedScript.trim()) {
    return Response.json(
      { error: "This run has no generated script to execute yet." },
      { status: 400 }
    );
  }
  const script = task.generatedScript;

  if (RUNNING.has(id)) {
    return Response.json(
      { error: "This script is already running locally." },
      { status: 409 }
    );
  }

  // Decrypted credentials are injected into the child env by the runner; they
  // are never sent to the stream.
  const app = await getApplication(task.applicationId);
  const username = app?.testUsername ?? "";
  const password = app?.testPassword ?? "";

  RUNNING.add(id);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown): void => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      void (async () => {
        try {
          send({ type: "start", taskId: id });

          const result = await runScriptHeaded({
            script,
            username,
            password,
            signal: request.signal,
            onLine: (ev) =>
              send({ type: "log", stream: ev.stream, line: ev.line }),
          });

          send({
            type: "result",
            passed: result.passed,
            exitCode: result.exitCode,
          });
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : "Run failed",
          });
        } finally {
          RUNNING.delete(id);
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
