import "dotenv/config";

/**
 * Standalone headless testing worker.
 *
 * "3 worker threads" is implemented as a CONCURRENCY CAP inside ONE process —
 * up to N tasks in flight at once — NOT node worker_threads. A single event
 * loop claims rows from the Postgres queue and dispatches the heavy
 * AI/browser pipelines (built in parallel by another engineer) concurrently.
 *
 * Loop shape:
 *   - Every POLL_INTERVAL_MS, while there is free capacity AND enough free RAM,
 *     atomically claim the next queued task and dispatch it WITHOUT awaiting
 *     (its promise is tracked in an in-flight set).
 *   - When a task settles, completeTask / failTask flips its status and the
 *     promise is removed from the set, freeing a slot for the next poll.
 *   - Every ~60s, sweep stale claims left behind by crashed workers.
 *
 * Status transitions are owned here (via the queue helpers). Pipelines only
 * update `stage` + artifact columns and THROW on fatal error.
 *
 * RELATIVE IMPORTS ONLY — tsx runs this file directly and cannot resolve the
 * `@/` path alias.
 */

import os from "node:os";
import {
  claimNextTask,
  completeTask,
  failTask,
  sweepStaleClaims,
  type ClaimedTask,
} from "../lib/queue";
// Heavy pipelines built in parallel by another engineer. Contract:
//   (taskId: string) => Promise<void>
// They do the full job (browse, generate, open PR), persist artifacts incl.
// prUrl, and THROW on fatal error. We never touch their stage/artifact writes.
import { runE2EPipeline } from "../lib/pipelines/e2e";
import { runExploratoryPipeline } from "../lib/pipelines/exploratory";

// --- Configuration (env with sane defaults) -------------------------------

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CONCURRENCY = intEnv("WORKER_CONCURRENCY", 3);
const POLL_INTERVAL_MS = intEnv("POLL_INTERVAL_MS", 10_000);
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}:${process.pid}`;
const STALE_CLAIM_TIMEOUT_MS = intEnv("STALE_CLAIM_TIMEOUT_MS", 900_000);
const MAX_TASK_ATTEMPTS = intEnv("MAX_TASK_ATTEMPTS", 2);
const MEM_FREE_FLOOR_MB = intEnv("MEM_FREE_FLOOR_MB", 1024);

// How long to keep draining in-flight work on shutdown before forcing exit.
const MAX_DRAIN_MS = intEnv("MAX_DRAIN_MS", 120_000);
// Run the stale-claim sweep every Nth poll tick (~60s at the default interval).
const SWEEP_EVERY_TICKS = 6;

// --- Runtime state ---------------------------------------------------------

/** Promises for tasks currently executing. Size === active concurrency. */
const inflight = new Set<Promise<void>>();
/** When true we stop claiming new work (shutdown in progress). */
let draining = false;
let pollTimer: NodeJS.Timeout | null = null;
let tickCount = 0;

// --- Logging ---------------------------------------------------------------

function log(message: string): void {
  console.log(`[worker ${WORKER_ID}] ${new Date().toISOString()} ${message}`);
}

function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(
    `[worker ${WORKER_ID}] ${new Date().toISOString()} ${message}\n${detail}`
  );
}

// --- Capacity / backpressure ----------------------------------------------

/** Free RAM gate: MEM_FREE_FLOOR_MB===0 disables the check entirely. */
function hasMemoryHeadroom(): boolean {
  if (MEM_FREE_FLOOR_MB === 0) return true;
  const freeMb = os.freemem() / 1_048_576;
  return freeMb >= MEM_FREE_FLOOR_MB;
}

/** True when we may claim another task right now. */
function canClaim(): boolean {
  return !draining && inflight.size < CONCURRENCY && hasMemoryHeadroom();
}

// --- Task execution --------------------------------------------------------

/**
 * Run one claimed task to completion and flip its terminal status.
 *
 * Dispatches by `kind`, awaits the pipeline, then completeTask on success or
 * failTask on throw. Fully self-contained: any error is caught and converted
 * to a failTask call, so a single task can never bubble up and crash the poll
 * loop. The in-flight slot is released in `finally`.
 */
async function runTask(task: ClaimedTask): Promise<void> {
  log(`claimed task ${task.id} (kind=${task.kind})`);
  try {
    switch (task.kind) {
      case "e2e":
        await runE2EPipeline(task.id);
        break;
      case "exploratory":
        await runExploratoryPipeline(task.id);
        break;
      default:
        throw new Error(`Unknown task kind: ${task.kind}`);
    }
    await completeTask(task.id);
    log(`completed task ${task.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`task ${task.id} failed: ${message}`, err);
    try {
      await failTask(task.id, message, MAX_TASK_ATTEMPTS);
    } catch (failErr) {
      // Even bookkeeping failed (e.g. DB blip). Log loudly; the stale-claim
      // sweep is the safety net that will eventually requeue/fail this row.
      logError(`failTask bookkeeping failed for ${task.id}`, failErr);
    }
  }
}

/** Track a task promise in the in-flight set, auto-removing it when settled. */
function dispatch(task: ClaimedTask): void {
  const promise = runTask(task).finally(() => {
    inflight.delete(promise);
  });
  inflight.add(promise);
}

// --- Poll loop -------------------------------------------------------------

/**
 * One poll tick: greedily fill every free slot, then run the periodic sweep.
 *
 * Claims are issued sequentially so concurrent FOR UPDATE SKIP LOCKED grabs
 * stay cheap; dispatch is fire-and-forget. We stop as soon as the queue is
 * empty (claim returns null) or capacity/memory runs out, and wait for the
 * next interval.
 */
async function pollOnce(): Promise<void> {
  while (canClaim()) {
    let task: ClaimedTask | null;
    try {
      task = await claimNextTask(WORKER_ID);
    } catch (err) {
      logError("claimNextTask failed", err);
      break; // transient DB issue — back off until the next tick
    }
    if (!task) break; // queue empty
    dispatch(task);
  }

  // Periodic stale-claim sweep (~every 60s). Skip while draining.
  tickCount += 1;
  if (!draining && tickCount % SWEEP_EVERY_TICKS === 0) {
    try {
      const swept = await sweepStaleClaims(
        STALE_CLAIM_TIMEOUT_MS,
        MAX_TASK_ATTEMPTS
      );
      if (swept > 0) log(`swept ${swept} stale claim(s)`);
    } catch (err) {
      logError("sweepStaleClaims failed", err);
    }
  }
}

function scheduleNextPoll(): void {
  if (draining) return;
  pollTimer = setTimeout(async () => {
    await pollOnce();
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

// --- Graceful shutdown -----------------------------------------------------

/**
 * Stop claiming, let in-flight tasks drain (bounded by MAX_DRAIN_MS), then exit.
 * Idempotent so a second signal doesn't kick off a second drain.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  draining = true;
  log(`received ${signal}, draining ${inflight.size} in-flight task(s)...`);

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  const drainGuard = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (inflight.size > 0) {
        log(`drain timeout after ${MAX_DRAIN_MS}ms; ${inflight.size} task(s) still running`);
      }
      resolve();
    }, MAX_DRAIN_MS).unref();
  });

  await Promise.race([
    Promise.allSettled([...inflight]).then(() => undefined),
    drainGuard,
  ]);

  log("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// --- Startup ---------------------------------------------------------------

function start(): void {
  log(
    "starting worker: " +
      JSON.stringify({
        workerId: WORKER_ID,
        concurrency: CONCURRENCY,
        pollIntervalMs: POLL_INTERVAL_MS,
        staleClaimTimeoutMs: STALE_CLAIM_TIMEOUT_MS,
        maxTaskAttempts: MAX_TASK_ATTEMPTS,
        memFreeFloorMb: MEM_FREE_FLOOR_MB,
        maxDrainMs: MAX_DRAIN_MS,
      })
  );

  // Kick an immediate poll so a freshly-started worker drains a backlog
  // without waiting a full interval, then settle into the scheduled cadence.
  void pollOnce().finally(scheduleNextPoll);
}

start();
