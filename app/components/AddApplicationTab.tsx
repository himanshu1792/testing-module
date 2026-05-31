"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  AppWindow,
  GitBranch,
  Boxes,
  Loader2,
  Info,
  Lock,
  ExternalLink,
  PackagePlus,
} from "lucide-react";
import {
  fetcher,
  type Application,
  type ApplicationsResponse,
  type Provider,
} from "./types";
import { TableSkeleton } from "./Skeleton";
import EmptyState from "./EmptyState";

const APPS_KEY = "/api/applications";

/** Tab 1: register applications-under-test and their git repositories. */
export default function AddApplicationTab() {
  const { data, isLoading } = useSWR<ApplicationsResponse>(APPS_KEY, fetcher);
  const applications = data?.applications ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* Forms sit side by side on wide screens (application left, repository
          right) and stack on narrow ones. Each card is wrapped so the
          `.tf-card + .tf-card` sibling margin can't offset the right column. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div>
          <AddApplicationCard />
        </div>
        <div>
          <AddRepositoryCard applications={applications} />
        </div>
      </div>
      <ApplicationsListCard applications={applications} isLoading={isLoading} />
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Card: Add application                                            */
/* ---------------------------------------------------------------- */

function AddApplicationCard() {
  const [name, setName] = useState("");
  const [testUrl, setTestUrl] = useState("");
  const [testUsername, setTestUsername] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    name.trim() && testUrl.trim() && testUsername.trim() && testPassword.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(APPS_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, testUrl, testUsername, testPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Failed to add application");
        return;
      }
      toast.success(`Application "${name}" added`);
      setName("");
      setTestUrl("");
      setTestUsername("");
      setTestPassword("");
      mutate(APPS_KEY);
    } catch {
      toast.error("Network error — could not add application");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="tf-card">
      <div className="tf-card-head">
        <span className="tf-card-icon">
          <AppWindow strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="tf-card-head__text">
          <h2 className="tf-card-title">Add application</h2>
          <p className="tf-card-desc">
            Register a web app under test. Login credentials are encrypted at
            rest and used by the worker to sign in during a run.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="tf-field">
          <label className="tf-label" htmlFor="app-name">
            Name <span className="tf-req" aria-hidden="true">*</span>
          </label>
          <input
            id="app-name"
            className="tf-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Web App"
            autoComplete="off"
            required
          />
        </div>

        <div className="tf-field">
          <label className="tf-label" htmlFor="app-url">
            Test URL <span className="tf-req" aria-hidden="true">*</span>
          </label>
          <input
            id="app-url"
            className="tf-input"
            type="url"
            value={testUrl}
            onChange={(e) => setTestUrl(e.target.value)}
            placeholder="https://staging.example.com"
            autoComplete="off"
            required
          />
        </div>

        <div className="tf-row">
          <div className="tf-field">
            <label className="tf-label" htmlFor="app-username">
              Test username <span className="tf-req" aria-hidden="true">*</span>
            </label>
            <input
              id="app-username"
              className="tf-input"
              value={testUsername}
              onChange={(e) => setTestUsername(e.target.value)}
              placeholder="qa@example.com"
              autoComplete="off"
              required
            />
          </div>
          <div className="tf-field">
            <label className="tf-label" htmlFor="app-password">
              Test password <span className="tf-req" aria-hidden="true">*</span>
            </label>
            <input
              id="app-password"
              className="tf-input"
              type="password"
              value={testPassword}
              onChange={(e) => setTestPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              required
            />
          </div>
        </div>

        <p className="tf-hint" style={{ marginTop: 14 }}>
          <Lock aria-hidden="true" />
          Credentials are encrypted at rest — only the worker decrypts them at
          run time.
        </p>

        <div className="tf-row mt-5">
          <button
            type="submit"
            className="tf-btn tf-btn--primary"
            disabled={!canSubmit || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="tf-spin" aria-hidden="true" />
                Adding…
              </>
            ) : (
              <>
                <PackagePlus aria-hidden="true" />
                Add application
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Card: Add repository                                             */
/* ---------------------------------------------------------------- */

function AddRepositoryCard({ applications }: { applications: Application[] }) {
  const [provider, setProvider] = useState<Provider>("github");
  const [repoUrl, setRepoUrl] = useState("");
  const [pat, setPat] = useState("");
  const [organization, setOrganization] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const orgRequired = provider === "ado";
  const canSubmit =
    repoUrl.trim() &&
    pat.trim() &&
    outputFolder.trim() &&
    applicationId &&
    (!orgRequired || organization.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          repoUrl,
          pat,
          organization: orgRequired ? organization : null,
          outputFolder,
          applicationId,
        }),
      });
      if (!res.ok) {
        // PAT validation / bad URL come back as 400 { error } — surface it.
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Failed to add repository");
        return;
      }
      toast.success("Repository connected");
      setRepoUrl("");
      setPat("");
      setOrganization("");
      setOutputFolder("");
      // keep provider + selected application for convenience
      mutate("/api/repositories");
      mutate(`/api/repositories?applicationId=${applicationId}`);
    } catch {
      toast.error("Network error — could not add repository");
    } finally {
      setSubmitting(false);
    }
  }

  const noApps = applications.length === 0;

  return (
    <section className="tf-card">
      <div className="tf-card-head">
        <span className="tf-card-icon">
          <GitBranch strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="tf-card-head__text">
          <h2 className="tf-card-title">Add repository</h2>
          <p className="tf-card-desc">
            Connect a GitHub or Azure DevOps repo. Generated test specs are
            committed here and opened as a pull request. The PAT is validated
            before it is saved.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="tf-field">
          <span className="tf-label">Provider</span>
          <div
            className="tf-segmented"
            role="radiogroup"
            aria-label="Repository provider"
          >
            <button
              type="button"
              role="radio"
              aria-checked={provider === "github"}
              className={`tf-segmented__opt ${
                provider === "github" ? "tf-segmented__opt--active" : ""
              }`}
              onClick={() => setProvider("github")}
            >
              GitHub
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={provider === "ado"}
              className={`tf-segmented__opt ${
                provider === "ado" ? "tf-segmented__opt--active" : ""
              }`}
              onClick={() => setProvider("ado")}
            >
              ADO
            </button>
          </div>
        </div>

        <div className="tf-field">
          <label className="tf-label" htmlFor="repo-url">
            Repository URL <span className="tf-req" aria-hidden="true">*</span>
          </label>
          <input
            id="repo-url"
            className="tf-input"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder={
              provider === "github"
                ? "https://github.com/org/repo"
                : "https://dev.azure.com/org/project/_git/repo"
            }
            autoComplete="off"
            required
          />
        </div>

        <div className="tf-field">
          <label className="tf-label" htmlFor="repo-pat">
            Personal Access Token{" "}
            <span className="tf-req" aria-hidden="true">*</span>
          </label>
          <input
            id="repo-pat"
            className="tf-input"
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="ghp_… / Azure DevOps PAT"
            autoComplete="new-password"
            required
          />
          <span className="tf-hint">
            <Lock aria-hidden="true" />
            Validated against the provider before it is stored, then encrypted at
            rest.
          </span>
        </div>

        {provider === "ado" && (
          <div className="tf-field">
            <label className="tf-label" htmlFor="repo-org">
              Organization <span className="tf-req" aria-hidden="true">*</span>
            </label>
            <input
              id="repo-org"
              className="tf-input"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="my-azure-org"
              autoComplete="off"
              required
            />
            <span className="tf-hint">
              <Info aria-hidden="true" />
              Required for Azure DevOps — the org that owns the project.
            </span>
          </div>
        )}

        <div className="tf-field">
          <label className="tf-label" htmlFor="repo-folder">
            Output folder <span className="tf-req" aria-hidden="true">*</span>
          </label>
          <input
            id="repo-folder"
            className="tf-input"
            value={outputFolder}
            onChange={(e) => setOutputFolder(e.target.value)}
            placeholder="tests/e2e"
            autoComplete="off"
            required
          />
          <span className="tf-hint">
            <Info aria-hidden="true" />
            Folder in the repo where specs are committed, e.g. tests/e2e
          </span>
        </div>

        <div className="tf-field">
          <label className="tf-label" htmlFor="repo-app">
            Application <span className="tf-req" aria-hidden="true">*</span>
          </label>
          <select
            id="repo-app"
            className="tf-select"
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            disabled={noApps}
            required
          >
            <option value="">
              {noApps ? "Add an application first" : "Select an application…"}
            </option>
            {applications.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
          {noApps && (
            <span className="tf-hint">
              <Info aria-hidden="true" />
              Create an application above before connecting a repository.
            </span>
          )}
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
                Validating…
              </>
            ) : (
              <>
                <GitBranch aria-hidden="true" />
                Add repository
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Card: existing applications list                                */
/* ---------------------------------------------------------------- */

function ApplicationsListCard({
  applications,
  isLoading,
}: {
  applications: Application[];
  isLoading: boolean;
}) {
  return (
    <section className="tf-card">
      <div className="tf-card-head">
        <span className="tf-card-icon">
          <Boxes strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="tf-card-head__text">
          <h2 className="tf-card-title">Applications</h2>
          <p className="tf-card-desc">
            Apps registered for testing and how many runs each has had.
          </p>
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton columns={[2, 3, 1]} rows={3} />
      ) : applications.length === 0 ? (
        <EmptyState
          icon={AppWindow}
          title="No applications yet"
          description="Register your first web app above to start queuing test runs against it."
        />
      ) : (
        <div className="tf-table-wrap">
          <div className="overflow-x-auto">
            <table className="tf-table">
              <thead>
                <tr>
                  <th className="tf-th">Name</th>
                  <th className="tf-th">Test URL</th>
                  <th className="tf-th" style={{ textAlign: "right" }}>
                    Runs
                  </th>
                </tr>
              </thead>
              <tbody>
                {applications.map((app) => (
                  <tr key={app.id}>
                    <td className="tf-td" style={{ fontWeight: 600 }}>
                      {app.name}
                    </td>
                    <td className="tf-td">
                      <a
                        className="tf-link"
                        href={app.testUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {app.testUrl}
                        <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    </td>
                    <td
                      className="tf-td tf-tnum"
                      style={{ textAlign: "right" }}
                    >
                      {app.runCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
