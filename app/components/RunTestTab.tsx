"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  Rocket,
  Loader2,
  Route,
  Compass,
  Info,
  Ticket,
  Send,
  AlertCircle,
} from "lucide-react";
import {
  fetcher,
  type ApplicationsResponse,
  type RepositoriesResponse,
  type TaskKind,
} from "./types";

/** Tab 2: queue an e2e or exploratory test run for an app + repo. */
export default function RunTestTab({
  onQueued,
}: {
  /** Called after a task is successfully queued (parent switches tabs). */
  onQueued: () => void;
}) {
  const { data: appsData } = useSWR<ApplicationsResponse>(
    "/api/applications",
    fetcher
  );
  const applications = appsData?.applications ?? [];

  const [kind, setKind] = useState<TaskKind>("e2e");
  const [applicationId, setApplicationId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [inputText, setInputText] = useState("");
  const [adoTicket, setAdoTicket] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Dependent repositories — re-fetched whenever the chosen application changes.
  // Conditional SWR key: no fetch until an application is selected.
  const { data: reposData, isLoading: reposLoading } =
    useSWR<RepositoriesResponse>(
      applicationId
        ? `/api/repositories?applicationId=${applicationId}`
        : null,
      fetcher
    );
  const repositories = reposData?.repositories ?? [];

  // Reset the repository choice when the application changes so a stale repo
  // from a different app can't be submitted.
  useEffect(() => {
    setRepositoryId("");
  }, [applicationId]);

  const appChosen = Boolean(applicationId);
  const noRepos = appChosen && !reposLoading && repositories.length === 0;
  const canSubmit =
    appChosen && Boolean(repositoryId) && inputText.trim().length > 0;

  const inputLabel =
    kind === "e2e" ? "Scenario (plain English)" : "Target URL to explore";
  const inputPlaceholder =
    kind === "e2e"
      ? "Log in, add an item to the cart, and verify the total updates."
      : "https://staging.example.com/dashboard";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          inputText,
          applicationId,
          repositoryId,
          // Only include adoTicket when the user actually entered something.
          ...(adoTicket.trim() ? { adoTicket: adoTicket.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Failed to queue task");
        return;
      }
      toast.success("Task queued — a worker will pick it up shortly");
      setInputText("");
      setAdoTicket("");
      onQueued();
    } catch {
      toast.error("Network error — could not queue task");
    } finally {
      setSubmitting(false);
    }
  }

  const noApps = applications.length === 0;

  return (
    <section className="tf-card">
      <div className="tf-card-head">
        <span className="tf-card-icon">
          <Rocket strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="tf-card-head__text">
          <h2 className="tf-card-title">Run a test</h2>
          <p className="tf-card-desc">
            Queue an end-to-end or exploratory run. The worker generates a spec,
            runs it against the app, and opens a pull request in the chosen repo.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        {/* Two columns on wide screens: the scenario sits on the right, the
            run configuration on the left. The scenario is kept first in the
            DOM so that when the grid collapses to a single column on mobile it
            appears before the submit button instead of after it. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-5 items-start">
          {/* Right column — scenario / target URL */}
          <div className="lg:col-start-2 lg:row-start-1">
            <div className="tf-field">
              <label className="tf-label" htmlFor="run-input">
                {inputLabel}{" "}
                <span className="tf-req" aria-hidden="true">
                  *
                </span>
              </label>
              <textarea
                id="run-input"
                className="tf-textarea"
                style={{ minHeight: 340 }}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={inputPlaceholder}
                required
              />
              <span className="tf-hint">
                <Info aria-hidden="true" />
                {kind === "e2e"
                  ? "Describe the user journey in plain English; the agent turns it into a Playwright spec."
                  : "The agent autonomously explores from this URL and reports what it finds."}
              </span>
            </div>
          </div>

          {/* Left column — run configuration */}
          <div className="lg:col-start-1 lg:row-start-1">
            <div className="tf-field">
              <span className="tf-label">Kind</span>
              <div
                className="tf-segmented"
                role="radiogroup"
                aria-label="Test kind"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === "e2e"}
                  className={`tf-segmented__opt ${
                    kind === "e2e" ? "tf-segmented__opt--active" : ""
                  }`}
                  onClick={() => setKind("e2e")}
                >
                  <Route size={15} aria-hidden="true" />
                  E2E
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === "exploratory"}
                  className={`tf-segmented__opt ${
                    kind === "exploratory" ? "tf-segmented__opt--active" : ""
                  }`}
                  onClick={() => setKind("exploratory")}
                >
                  <Compass size={15} aria-hidden="true" />
                  Exploratory
                </button>
              </div>
            </div>

            <div className="tf-field">
              <label className="tf-label" htmlFor="run-app">
                Application{" "}
                <span className="tf-req" aria-hidden="true">
                  *
                </span>
              </label>
              <select
                id="run-app"
                className="tf-select"
                value={applicationId}
                onChange={(e) => setApplicationId(e.target.value)}
                disabled={noApps}
                required
              >
                <option value="">
                  {noApps ? "No applications yet" : "Select an application…"}
                </option>
                {applications.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="tf-field">
              <label className="tf-label" htmlFor="run-repo">
                Repository{" "}
                <span className="tf-req" aria-hidden="true">
                  *
                </span>
              </label>
              <select
                id="run-repo"
                className="tf-select"
                value={repositoryId}
                onChange={(e) => setRepositoryId(e.target.value)}
                disabled={!appChosen || reposLoading || noRepos}
                required
              >
                <option value="">
                  {!appChosen
                    ? "Choose an application first"
                    : reposLoading
                    ? "Loading repositories…"
                    : noRepos
                    ? "No repositories for this app"
                    : "Select a repository…"}
                </option>
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.provider === "ado" ? "ADO" : "GitHub"} — {repo.repoUrl}
                  </option>
                ))}
              </select>
              {noRepos && (
                <span className="tf-hint">
                  <AlertCircle aria-hidden="true" />
                  This application has no repositories. Add one in the Add
                  Application tab.
                </span>
              )}
            </div>

            <div className="tf-field">
              <label className="tf-label" htmlFor="run-ado">
                ADO Ticket
                <span className="tf-optional">Optional</span>
              </label>
              <input
                id="run-ado"
                className="tf-input"
                value={adoTicket}
                onChange={(e) => setAdoTicket(e.target.value)}
                placeholder="e.g. 12345"
                autoComplete="off"
              />
              <span className="tf-hint">
                <Ticket aria-hidden="true" />
                Link a work item for acceptance criteria — handy when the repo is
                Azure DevOps.
              </span>
            </div>

            <div className="tf-row mt-5">
              <button
                type="submit"
                className="tf-btn tf-btn--primary"
                disabled={!canSubmit || submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="tf-spin" aria-hidden="true" />
                    Queuing…
                  </>
                ) : (
                  <>
                    <Send aria-hidden="true" />
                    Queue test run
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
