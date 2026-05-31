/**
 * Workspace path helpers (pure — no git, no secrets, no I/O).
 *
 * Each Application gets a local git clone under `workspace/<applicationName>`.
 * These helpers resolve and sanitize that path. They are deliberately free of
 * any filesystem or child_process calls so they can be unit-reasoned and reused
 * by both the worker (pipelines) and the Next.js API route.
 *
 * Relative imports only (this module is consumed by the tsx worker, which cannot
 * resolve the `@/` alias).
 */

import path from "node:path";

export const WORKSPACE_DIRNAME = "workspace";

/**
 * Sanitize a name into a single safe path segment.
 *
 * PRESERVES CASE on purpose: an Application named "TLI" must map to the
 * `workspace/TLI` directory (not `workspace/tli`). Rules:
 *  - trim surrounding whitespace
 *  - replace any character outside [A-Za-z0-9._-] with "-"
 *  - collapse runs of "-" into a single "-"
 *  - strip leading/trailing "-" and "."
 *  - reject "." / ".." (path-traversal guards) -> fallback "app"
 *  - empty result -> fallback "app"
 */
export function sanitizeWorkspaceName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "app";
  }
  return cleaned;
}

/**
 * Absolute path to the workspace clone for an application.
 *
 * v1 callers pass only `appName` -> `<cwd>/workspace/<appName>`.
 *
 * The optional `repoSubdir` (reserved for future multi-repo support) appends a
 * third segment -> `<cwd>/workspace/<appName>/<repoSubdir>`.
 *
 * KNOWN LIMITATION (v1): if a single Application owns multiple repositories,
 * they would all collide at `workspace/<appName>` because v1 callers never pass
 * `repoSubdir`. This is acceptable for v1 — the optional param is kept only so a
 * future change can disambiguate without a signature break.
 */
export function workspacePathFor(appName: string, repoSubdir?: string): string {
  const segments = [process.cwd(), WORKSPACE_DIRNAME, sanitizeWorkspaceName(appName)];
  if (repoSubdir !== undefined) {
    segments.push(sanitizeWorkspaceName(repoSubdir));
  }
  return path.join(...segments);
}
