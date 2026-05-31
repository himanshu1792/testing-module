/**
 * Local-git workspace engine (server-only).
 *
 * Clones/pulls a repository into a local workspace and performs the disk-first
 * spec push: write file -> add -> commit (inline identity) -> push. PR creation
 * itself lives in ./agents/git-providers — this module only handles the git CLI.
 *
 * Relative imports only (consumed by the tsx worker, which cannot resolve `@/`).
 *
 * SECURITY — the single most important control in this file:
 *   The authenticated remote URL embeds the PAT and must exist ONLY as an
 *   in-memory argv element. It is NEVER written to `.git/config` (after clone we
 *   immediately reset `origin` to a token-free URL) and NEVER logged. Because
 *   `execFile` rejections embed the full command line (including the authed URL
 *   and therefore the PAT), EVERY git invocation goes through `git()`, which
 *   funnels the rejection through `redact()`. No raw child_process error may
 *   escape this module.
 *
 * STATUS OWNERSHIP: these functions throw on failure and never touch task
 * status — the worker owns status/startedAt/finishedAt.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseGitHubUrl, parseAdoUrl } from "./repository-utils";

const exec = promisify(execFile);

// ──────────────── Secret-safe URL construction ────────────────

/** Authenticated clone/fetch/pull/push URL. In-memory argv ONLY — never persisted/logged. */
function authedUrlFor(
  provider: string,
  repoUrl: string,
  pat: string,
  organization: string | null
): string {
  if (provider === "github") {
    const { owner, repo } = parseGitHubUrl(repoUrl);
    return `https://x-access-token:${encodeURIComponent(pat)}@github.com/${owner}/${repo}.git`;
  }
  if (provider === "ado") {
    if (!organization) {
      throw new Error("Azure DevOps requires an organization name");
    }
    const { project, repoName } = parseAdoUrl(repoUrl);
    return `https://pat:${encodeURIComponent(pat)}@dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}`;
  }
  throw new Error(`Unsupported repository provider: ${provider}`);
}

/** Clean, token-free remote URL — safe to persist as `origin` and to log. */
function cleanUrlFor(
  provider: string,
  repoUrl: string,
  organization: string | null
): string {
  if (provider === "github") {
    const { owner, repo } = parseGitHubUrl(repoUrl);
    return `https://github.com/${owner}/${repo}.git`;
  }
  if (provider === "ado") {
    if (!organization) {
      throw new Error("Azure DevOps requires an organization name");
    }
    const { project, repoName } = parseAdoUrl(repoUrl);
    return `https://dev.azure.com/${organization}/${project}/_git/${repoName}`;
  }
  throw new Error(`Unsupported repository provider: ${provider}`);
}

// ──────────────── Redaction + git runner ────────────────

/**
 * Strip the PAT (and the `x-access-token:<pat>@` / `pat:<pat>@` userinfo forms)
 * from any string before it is thrown or logged. Replaces both the raw token and
 * its URL-encoded form, since the authed URL encodes it.
 */
function redact(s: string, pat: string): string {
  let out = s;
  if (pat) {
    const encoded = encodeURIComponent(pat);
    // Userinfo prefixes first (most specific), then any bare token occurrences.
    out = out
      .split(`x-access-token:${pat}@`).join("***@")
      .split(`x-access-token:${encoded}@`).join("***@")
      .split(`pat:${pat}@`).join("***@")
      .split(`pat:${encoded}@`).join("***@")
      .split(pat).join("***")
      .split(encoded).join("***");
  }
  return out;
}

/**
 * Run a git command with args as an ARRAY (never a shell string).
 * On rejection, re-throw an Error whose message has the PAT redacted — this is
 * the mandatory wrapper that prevents the token leaking via execFile's
 * command-line-bearing error objects.
 */
async function git(
  args: string[],
  pat: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("git", args, { windowsHide: true });
  } catch (err) {
    const raw =
      (err as { stderr?: string }).stderr ||
      (err as { message?: string }).message ||
      String(err);
    throw new Error(redact(String(raw), pat));
  }
}

/** True if `<dir>/.git` exists (i.e. the workspace is already a clone). */
async function isGitRepo(workspacePath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(workspacePath, ".git"));
    return true;
  } catch {
    return false;
  }
}

// ──────────────── Public API ────────────────

/**
 * Ensure `workspacePath` is a clone of `branch`, up to date with the remote.
 *
 * Idempotent — both the warm-clone (on repo add) and the pipeline pre-hook call
 * this. First call clones; subsequent calls stash-then-pull (NEVER reset --hard,
 * so in-flight local edits are preserved on the stash).
 *
 * Throws on failure (with the PAT redacted). Never sets task status.
 */
export async function syncWorkspace(args: {
  workspacePath: string;
  repoUrl: string;
  provider: string;
  pat: string;
  organization: string | null;
  branch: string;
}): Promise<void> {
  const { workspacePath, repoUrl, provider, pat, organization, branch } = args;
  const authedUrl = authedUrlFor(provider, repoUrl, pat, organization);

  if (!(await isGitRepo(workspacePath))) {
    // Fresh clone. Create the parent dir, clone the single branch, then strip
    // the token from origin so it never lands in .git/config.
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await git(
      ["clone", "--branch", branch, "--single-branch", authedUrl, workspacePath],
      pat
    );
    const cleanUrl = cleanUrlFor(provider, repoUrl, organization);
    await git(["-C", workspacePath, "remote", "set-url", "origin", cleanUrl], pat);
    return;
  }

  // Existing clone: stash any local changes (best-effort), then fetch + pull the
  // target branch using the authed URL passed explicitly as an argument.
  try {
    await git(["-C", workspacePath, "stash", "--include-untracked"], pat);
  } catch {
    // "No local changes to save" / "nothing to stash" is success, not an error.
  }

  await git(["-C", workspacePath, "fetch", authedUrl, branch], pat);

  // Check out the branch, creating a local tracking branch from FETCH_HEAD if it
  // does not exist yet. `-B` makes this safe to repeat.
  await git(["-C", workspacePath, "checkout", "-B", branch, "FETCH_HEAD"], pat);

  await git(["-C", workspacePath, "pull", authedUrl, branch], pat);
}

/**
 * Disk-first spec push: write the file into the workspace, then commit and
 * force-with-lease push a new branch off `baseBranch`. The caller (pr-creator)
 * opens the PR afterwards.
 *
 * Throws on failure (with the PAT redacted). Never sets task status.
 */
export async function commitAndPushSpec(args: {
  workspacePath: string;
  provider: string;
  repoUrl: string;
  pat: string;
  organization: string | null;
  baseBranch: string;
  newBranch: string;
  relFilePath: string;
  fileContent: string;
  commitMessage: string;
}): Promise<void> {
  const {
    workspacePath,
    provider,
    repoUrl,
    pat,
    organization,
    baseBranch,
    newBranch,
    relFilePath,
    fileContent,
    commitMessage,
  } = args;

  // 1. Land on the base branch (caller already synced it).
  await git(["-C", workspacePath, "checkout", baseBranch], pat);

  // 2. Create/reset the feature branch off the base (-B = idempotent on rerun).
  await git(["-C", workspacePath, "checkout", "-B", newBranch, baseBranch], pat);

  // 3. Resolve + validate the target path stays inside the workspace, then write.
  const absTarget = path.resolve(workspacePath, relFilePath);
  const absRoot = path.resolve(workspacePath);
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (path.isAbsolute(relFilePath) || (absTarget !== absRoot && !absTarget.startsWith(rootWithSep))) {
    throw new Error("Invalid spec path: must stay within the workspace");
  }
  await fs.mkdir(path.dirname(absTarget), { recursive: true });
  await fs.writeFile(absTarget, fileContent, "utf-8");

  // 4. Stage the file (use `--` so a path starting with `-` can't be an option).
  await git(["-C", workspacePath, "add", "--", relFilePath], pat);

  // 5. Commit with INLINE identity — never mutate git config.
  await git(
    [
      "-c",
      "user.name=TestForge",
      "-c",
      "user.email=testforge@local",
      "-C",
      workspacePath,
      "commit",
      "-m",
      commitMessage,
    ],
    pat
  );

  // 6. Push the branch with the authed URL (argv only) using force-with-lease so
  // reruns update the branch without clobbering unexpected remote movement.
  const authedUrl = authedUrlFor(provider, repoUrl, pat, organization);
  await git(
    ["-C", workspacePath, "push", "--force-with-lease", authedUrl, `HEAD:refs/heads/${newBranch}`],
    pat
  );
}
