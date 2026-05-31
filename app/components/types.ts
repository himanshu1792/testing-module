// Shared client-side types + SWR fetcher for the Headless TestForge UI.
// These mirror the API contract returned by app/api/* routes.

export type Provider = "github" | "ado";
export type TaskKind = "e2e" | "exploratory";

/** Known task statuses per the API contract (note: "done", not "completed"). */
export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface Application {
  id: string;
  name: string;
  testUrl: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  provider: string;
  repoUrl: string;
  organization?: string | null;
  outputFolder?: string;
  applicationId: string;
}

export interface Task {
  id: string;
  kind: string;
  inputText: string;
  status: string;
  stage: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  applicationId: string;
  repositoryId: string;
  createdAt: string;
  updatedAt: string;
  application: { name: string };
  repository: { provider: string; repoUrl: string };
}

export interface ApplicationsResponse {
  applications: Application[];
}
export interface RepositoriesResponse {
  repositories: Repository[];
}
export interface TasksResponse {
  tasks: Task[];
}

/** Generic JSON fetcher for SWR. */
export const fetcher = <T = unknown>(url: string): Promise<T> =>
  fetch(url).then((r) => r.json() as Promise<T>);

/** The four statuses we render badges for; everything else falls back safely. */
const KNOWN_STATUSES: TaskStatus[] = ["queued", "running", "done", "failed"];

/** Map any status string to a valid badge modifier (defensive). */
export function badgeModifier(status: string): TaskStatus {
  const s = status?.toLowerCase();
  if ((KNOWN_STATUSES as string[]).includes(s)) return s as TaskStatus;
  // Treat legacy "completed" as "done" so the badge still renders correctly.
  if (s === "completed") return "done";
  return "queued";
}
