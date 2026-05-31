"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  History,
  Route,
  Compass,
  ExternalLink,
  GitPullRequest,
  Clock,
  CircleDashed,
  Loader2,
  CheckCircle2,
  XCircle,
  WifiOff,
  Inbox,
  Play,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  fetcher,
  badgeModifier,
  type Task,
  type TaskStatus,
  type TasksResponse,
} from "./types";
import { TableSkeleton } from "./Skeleton";
import EmptyState from "./EmptyState";
import RunScriptModal from "./RunScriptModal";

/** Truncate long input text for the table cell. */
function truncate(text: string, max = 60): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Localized short time, resilient to bad/missing timestamps. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One Lucide glyph per status — keeps the badge legible beyond color alone. */
const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  queued: CircleDashed,
  running: Loader2,
  done: CheckCircle2,
  failed: XCircle,
};

/** Tab 3: live-ish list of queued/running/finished runs (polls every 5s). */
export default function PreviousRunsTab() {
  const { data, error, isLoading } = useSWR<TasksResponse>(
    "/api/tasks",
    fetcher,
    { refreshInterval: 5000 }
  );

  const tasks = data?.tasks ?? [];

  // The run whose script is currently open in the local-run modal (or none).
  const [runTask, setRunTask] = useState<Task | null>(null);

  return (
    <section className="tf-card">
      <div className="tf-card-head">
        <span className="tf-card-icon">
          <History strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="tf-card-head__text">
          <h2 className="tf-card-title">Previous runs</h2>
          <p className="tf-card-desc">
            Updates automatically every few seconds as the worker progresses.
          </p>
        </div>
      </div>

      {isLoading && !data ? (
        <TableSkeleton columns={[1, 3, 1.6, 1.2, 1.2, 1, 1.4, 1]} rows={5} />
      ) : error ? (
        <EmptyState
          icon={WifiOff}
          title="Could not load runs"
          description="The runs feed is unavailable right now. We’ll keep retrying automatically in the background."
        />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No runs yet"
          description="Queue an end-to-end or exploratory run from the Run Test tab and it will show up here."
        />
      ) : (
        <div className="tf-table-wrap">
          <div className="overflow-x-auto">
            <table className="tf-table">
              <thead>
                <tr>
                  <th className="tf-th">Kind</th>
                  <th className="tf-th">Input</th>
                  <th className="tf-th">Application</th>
                  <th className="tf-th">Status</th>
                  <th className="tf-th">Stage</th>
                  <th className="tf-th">PR</th>
                  <th className="tf-th">Created</th>
                  <th className="tf-th">Run</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} onRun={setRunTask} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {runTask && (
        <RunScriptModal task={runTask} onClose={() => setRunTask(null)} />
      )}
    </section>
  );
}

function TaskRow({
  task,
  onRun,
}: {
  task: Task;
  onRun: (task: Task) => void;
}) {
  const status = badgeModifier(task.status);
  const failed = status === "failed";
  const exploratory = task.kind === "exploratory";
  const kindLabel = exploratory ? "Exploratory" : "E2E";
  const KindIcon = exploratory ? Compass : Route;
  const StatusIcon = STATUS_ICON[status];
  // Run is only actionable once the backend reports a generated script.
  const canRun = task.hasScript === true;

  return (
    <tr>
      <td className="tf-td">
        <span className="tf-tag">
          <KindIcon aria-hidden="true" />
          {kindLabel}
        </span>
      </td>
      <td className="tf-td">
        <span title={task.inputText}>{truncate(task.inputText)}</span>
        {failed && task.errorMessage && (
          <div className="tf-error mt-1" title={task.errorMessage}>
            <XCircle aria-hidden="true" />
            {truncate(task.errorMessage, 80)}
          </div>
        )}
      </td>
      <td className="tf-td">{task.application?.name ?? "—"}</td>
      <td className="tf-td">
        <span
          className={`tf-badge tf-badge--${status}`}
          title={failed && task.errorMessage ? task.errorMessage : undefined}
        >
          <StatusIcon
            size={12}
            strokeWidth={2.5}
            className={status === "running" ? "tf-spin" : undefined}
            aria-hidden="true"
          />
          {task.status}
        </span>
      </td>
      <td className="tf-td">
        {task.stage ? (
          <span className="tf-mono">{task.stage}</span>
        ) : (
          <span style={{ color: "var(--color-faint)" }}>—</span>
        )}
      </td>
      <td className="tf-td">
        {task.prUrl ? (
          <a
            className="tf-link"
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <GitPullRequest size={14} aria-hidden="true" />
            View PR
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : (
          <span style={{ color: "var(--color-faint)" }}>—</span>
        )}
      </td>
      <td className="tf-td">
        <span className="tf-meta tf-tnum">
          <Clock aria-hidden="true" />
          {shortTime(task.createdAt)}
        </span>
      </td>
      <td className="tf-td">
        <button
          type="button"
          className="tf-btn tf-btn--ghost tf-runbtn"
          onClick={() => onRun(task)}
          disabled={!canRun}
          aria-disabled={!canRun}
          aria-label={
            canRun
              ? `Run script for ${task.application?.name ?? "this run"}`
              : "No generated script for this run yet"
          }
          title={
            canRun ? "Run this script locally" : "No generated script for this run yet."
          }
        >
          <Play aria-hidden="true" />
          Run
        </button>
      </td>
    </tr>
  );
}
