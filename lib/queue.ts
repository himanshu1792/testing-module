/**
 * Postgres-as-queue primitives for the headless testing worker.
 *
 * No Redis, no BullMQ. The atomic claim relies on
 * `SELECT ... FOR UPDATE SKIP LOCKED`, which lets N workers (or N concurrent
 * in-flight slots in one process) grab distinct rows without blocking each
 * other and without ever handing the same row to two claimers.
 *
 * The worker OWNS every status transition here:
 *   queued --claim--> running --completeTask--> done
 *                             \--failTask----> failed (retries exhausted)
 *                             \--failTask----> queued (requeue for retry)
 * Pipelines only mutate `stage` + artifact columns (refinedPrompt, testPlan,
 * generatedScript, prUrl), never `status`.
 *
 * IMPORTANT (schema/quoting): the `TestTask` model maps to Postgres table
 * "TestTask" with camelCase column names in schema `testing_agent`. The pg
 * adapter sets search_path from `DATABASE_URL ?schema=testing_agent`, so
 * unqualified identifiers resolve — but raw SQL MUST double-quote every
 * identifier ("TestTask", "createdAt", "lockedAt", ...) or Postgres folds
 * them to lowercase and the query breaks.
 */

import { prisma } from "./prisma";
import { getTask } from "./tasks";

/** A claimed unit of work. `kind` drives pipeline dispatch in the worker. */
export type ClaimedTask = { id: string; kind: string };

/**
 * Atomically claim the oldest queued task and mark it running.
 *
 * The inner `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` locks exactly one
 * queued row (skipping any rows already locked by a concurrent claimer); the
 * outer UPDATE flips it to `running`, stamps the lock owner/time, sets
 * `startedAt` once (COALESCE preserves the first start across retries), and
 * increments `attempts`. RETURNING gives us the claimed id + kind.
 *
 * @returns the claimed `{ id, kind }`, or `null` when the queue is empty.
 */
export async function claimNextTask(
  workerId: string
): Promise<ClaimedTask | null> {
  const sql = `
    UPDATE "TestTask" SET status='running', "lockedBy"=$1, "lockedAt"=now(),
      "startedAt"=COALESCE("startedAt", now()), attempts=attempts+1, "updatedAt"=now()
    WHERE id = (SELECT id FROM "TestTask" WHERE status='queued'
                ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, kind;
  `;

  const rows = await prisma.$queryRawUnsafe<ClaimedTask[]>(sql, workerId);
  return rows[0] ?? null;
}

/**
 * Mark a successfully-finished task as done and release its claim.
 *
 * Deliberately does NOT touch `prUrl` (or any artifact column) — the pipeline
 * already persisted the PR URL and other outputs before returning.
 */
export async function completeTask(taskId: string): Promise<void> {
  await prisma.testTask.update({
    where: { id: taskId },
    data: {
      status: "done",
      stage: "done",
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    },
  });
}

/**
 * Record a task failure: either give up or requeue for another attempt.
 *
 * `attempts` was already incremented at claim time, so we compare the current
 * value against `maxAttempts`:
 *   - attempts >= maxAttempts -> terminal `failed` (stamp errorMessage +
 *     finishedAt, release the lock).
 *   - otherwise -> back to `queued` so a future poll re-claims it (release the
 *     lock, keep `attempts` as-is, record the latest error for visibility).
 */
export async function failTask(
  taskId: string,
  errorMessage: string,
  maxAttempts: number
): Promise<void> {
  const task = await getTask(taskId);
  const attempts = task?.attempts ?? 0;

  if (attempts >= maxAttempts) {
    await prisma.testTask.update({
      where: { id: taskId },
      data: {
        status: "failed",
        errorMessage,
        finishedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      },
    });
    return;
  }

  await prisma.testTask.update({
    where: { id: taskId },
    data: {
      status: "queued",
      errorMessage,
      lockedBy: null,
      lockedAt: null,
    },
  });
}

/**
 * Reclaim tasks whose worker died mid-run (crash, OOM, hard kill).
 *
 * A `running` row whose `lockedAt` is older than `staleMs` is assumed orphaned
 * (its holder never released the lock). We split the orphans by retry budget:
 *   - attempts >= maxAttempts -> terminal `failed` with a stale-lock message.
 *   - otherwise               -> requeued (`queued`, lock cleared) for retry.
 *
 * Implemented as two `updateMany` calls against a JS-computed cutoff so it
 * stays a couple of cheap, index-friendly statements.
 *
 * @returns the total number of rows swept (failed + requeued).
 */
export async function sweepStaleClaims(
  staleMs: number,
  maxAttempts: number
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);

  // 1) Orphans that have exhausted their retries -> terminal failure.
  const failed = await prisma.testTask.updateMany({
    where: {
      status: "running",
      lockedAt: { lt: cutoff },
      attempts: { gte: maxAttempts },
    },
    data: {
      status: "failed",
      errorMessage: "Worker crashed or timed out (stale lock)",
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    },
  });

  // 2) Orphans with retries left -> requeue (leave attempts as-is).
  const requeued = await prisma.testTask.updateMany({
    where: {
      status: "running",
      lockedAt: { lt: cutoff },
      attempts: { lt: maxAttempts },
    },
    data: {
      status: "queued",
      lockedBy: null,
      lockedAt: null,
    },
  });

  return failed.count + requeued.count;
}
