import { NextResponse } from "next/server";
import { listTasks, createTask, type TaskKind } from "@/lib/tasks";

/**
 * Tasks API — thin DB-only layer over lib/tasks.
 *
 * POST only ENQUEUES a task (status defaults to "queued"). The standalone
 * worker process claims and executes it via the Postgres queue — no pipeline
 * work runs in this route.
 */

const VALID_KINDS: TaskKind[] = ["e2e", "exploratory"];

/** GET /api/tasks -> all tasks (most recent first) for the Previous Runs view. */
export async function GET() {
  const tasks = await listTasks();
  return NextResponse.json({ tasks });
}

/**
 * POST /api/tasks -> enqueue a new task.
 * Body: { kind, inputText, applicationId, repositoryId, adoTicket? }.
 * kind must be 'e2e' or 'exploratory'; inputText/applicationId/repositoryId
 * are required.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { kind, inputText, applicationId, repositoryId, adoTicket } = body ?? {};

    if (!VALID_KINDS.includes(kind) || !inputText || !applicationId || !repositoryId) {
      return NextResponse.json(
        {
          error:
            "kind must be 'e2e' or 'exploratory', and inputText, applicationId, and repositoryId are required",
        },
        { status: 400 }
      );
    }

    const task = await createTask({
      kind,
      inputText,
      applicationId,
      repositoryId,
      adoTicket: adoTicket ?? null,
    });

    return NextResponse.json(
      { task: { id: task.id, kind: task.kind, status: task.status } },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
