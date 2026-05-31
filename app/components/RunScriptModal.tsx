"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  MonitorPlay,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import type { Task } from "./types";

/** Lifecycle of an in-flight (or finished) local script run. */
type RunPhase = "running" | "passed" | "failed" | "error";

/** A single line streamed from the runner's child process. */
interface LogLine {
  /** Monotonic key so React can keep rows stable as we append. */
  key: number;
  stream: "stdout" | "stderr";
  line: string;
}

/* ----------------------------- NDJSON events ----------------------------- *
 * Mirrors POST /api/tasks/{id}/run (application/x-ndjson). One JSON per line.
 * ------------------------------------------------------------------------- */
type StreamEvent =
  | { type: "start"; taskId: string }
  | { type: "log"; stream: "stdout" | "stderr"; line: string }
  | { type: "result"; passed: boolean; exitCode: number }
  | { type: "error"; message: string };

/**
 * Modal that executes a run's generated Playwright script LOCALLY in a headed
 * Chromium window and streams its live log output. Mounted by the parent only
 * once a task is selected, so it kicks off the run on mount.
 *
 * Closing aborts the fetch; the backend ties request.signal to killing the
 * child process, so aborting also tears down the headed browser window.
 */
export default function RunScriptModal({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<RunPhase>("running");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The controller for the active fetch; aborted on close/unmount/re-run.
  const controllerRef = useRef<AbortController | null>(null);
  // Auto-scroll anchor + the close button we focus on open.
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  // Monotonic counter for stable log keys (avoids index-as-key churn).
  const lineSeq = useRef(0);

  const finished = phase !== "running";

  /** Open the NDJSON stream and pump events into state until it ends/aborts. */
  const startRun = useCallback(async () => {
    // Tear down any prior in-flight run before starting a fresh one.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setPhase("running");
    setLogs([]);
    setExitCode(null);
    setErrorMsg(null);
    lineSeq.current = 0;

    try {
      const res = await fetch(`/api/tasks/${task.id}/run`, {
        method: "POST",
        signal: controller.signal,
      });

      // Pre-stream failures arrive as a normal JSON body: { error }.
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* non-JSON body — keep the status-based message */
        }
        setErrorMsg(message);
        setPhase("error");
        return;
      }

      if (!res.body) {
        setErrorMsg("The run stream was empty.");
        setPhase("error");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read frames, split on newline, JSON.parse each complete line.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;

          let evt: StreamEvent;
          try {
            evt = JSON.parse(raw) as StreamEvent;
          } catch {
            continue; // skip malformed frames defensively
          }
          applyEvent(evt);
        }
      }
    } catch (err) {
      // Aborts are intentional (close/unmount/re-run) — stay quiet.
      if (controller.signal.aborted) return;
      setErrorMsg(
        err instanceof Error ? err.message : "Unexpected error while running."
      );
      setPhase("error");
    }
  }, [task.id]);

  /** Reduce a single stream event into component state. */
  function applyEvent(evt: StreamEvent) {
    switch (evt.type) {
      case "start":
        setPhase("running");
        break;
      case "log":
        setLogs((prev) => [
          ...prev,
          { key: lineSeq.current++, stream: evt.stream, line: evt.line },
        ]);
        break;
      case "result":
        setExitCode(evt.exitCode);
        setPhase(evt.passed ? "passed" : "failed");
        break;
      case "error":
        setErrorMsg(evt.message);
        setPhase("error");
        break;
    }
  }

  /** Abort the active fetch (kills the child + headed browser) then close. */
  const handleClose = useCallback(() => {
    controllerRef.current?.abort();
    onClose();
  }, [onClose]);

  // Start on mount; abort on unmount so the browser window can't linger.
  useEffect(() => {
    void startRun();
    return () => controllerRef.current?.abort();
  }, [startRun]);

  // Focus the close button on open (focus lands inside the dialog).
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Esc closes (and aborts) from anywhere while the modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Auto-scroll the console to the newest line as logs arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  const titleId = "run-script-modal-title";

  return (
    <div
      className="tf-modal__backdrop"
      onMouseDown={(e) => {
        // Only a click on the backdrop itself (not bubbled from the panel).
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className="tf-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="tf-modal__head">
          <div className="tf-modal__headtext">
            <h2 id={titleId} className="tf-modal__title">
              Run script locally
            </h2>
            <p className="tf-modal__sub" title={task.inputText}>
              {task.application?.name ?? "Run"} ·{" "}
              {task.kind === "exploratory" ? "Exploratory" : "E2E"}
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="tf-iconbtn"
            onClick={handleClose}
            aria-label="Close run dialog"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {/* Core of the feature: tell the user where to watch the live run. */}
        <div className="tf-runhint" role="note">
          <MonitorPlay aria-hidden="true" />
          <span>
            A Chromium window will open on this computer — watch the test run
            there live.
          </span>
        </div>

        {/* Streaming console. aria-live so SR users hear new output. */}
        <div
          className="tf-console"
          role="log"
          aria-live="polite"
          aria-label="Live run output"
        >
          {logs.length === 0 && phase === "running" ? (
            <div className="tf-console__empty">Starting run…</div>
          ) : (
            logs.map((l) => (
              <div
                key={l.key}
                className={
                  l.stream === "stderr"
                    ? "tf-console__line tf-console__line--err"
                    : "tf-console__line"
                }
              >
                {l.line}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>

        <footer className="tf-modal__foot">
          <div className="tf-runstatus" aria-live="polite">
            {phase === "running" && (
              <span className="tf-runstatus__msg tf-runstatus__msg--run">
                <Loader2 className="tf-spin" aria-hidden="true" />
                Running…
              </span>
            )}
            {phase === "passed" && (
              <span className="tf-runstatus__msg tf-runstatus__msg--ok">
                <CheckCircle2 aria-hidden="true" />
                Passed
              </span>
            )}
            {phase === "failed" && (
              <span className="tf-runstatus__msg tf-runstatus__msg--bad">
                <XCircle aria-hidden="true" />
                Failed (exit {exitCode ?? "?"})
              </span>
            )}
            {phase === "error" && (
              <span className="tf-runstatus__msg tf-runstatus__msg--bad">
                <AlertTriangle aria-hidden="true" />
                {errorMsg ?? "Something went wrong."}
              </span>
            )}
          </div>

          <div className="tf-modal__actions">
            {finished && (
              <button
                type="button"
                className="tf-btn tf-btn--primary"
                onClick={() => void startRun()}
              >
                <RefreshCw aria-hidden="true" />
                Run again
              </button>
            )}
            <button
              type="button"
              className="tf-btn tf-btn--ghost"
              onClick={handleClose}
            >
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
