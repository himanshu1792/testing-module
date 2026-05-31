import { parseGitHubUrl, parseAdoUrl } from "../repository-utils";

export interface PrCreationResult {
  prUrl: string;
}

// ──────────────── GitHub ────────────────

/**
 * Open a pull request on GitHub.
 *
 * The branch and file have already been created/pushed by the local-git engine
 * (lib/workspace-git.ts), so this only opens the PR. `base` is supplied by the
 * caller (the repository's configured branch) — there is no default-branch
 * lookup anymore. Uses the GitHub REST API with a PAT (Bearer auth).
 */
export async function openGitHubPr(
  repoUrl: string,
  pat: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<PrCreationResult> {
  const { owner, repo } = parseGitHubUrl(repoUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

  const prRes = await fetch(`${baseUrl}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!prRes.ok) {
    throw new Error(`GitHub: Failed to create PR (${prRes.status})`);
  }
  const prData = (await prRes.json()) as { html_url: string };

  return { prUrl: prData.html_url };
}

// ──────────────── Azure DevOps ────────────────

/**
 * Open a pull request on Azure DevOps.
 *
 * The branch and file have already been created/pushed by the local-git engine
 * (lib/workspace-git.ts), so this only opens the PR. `base` is supplied by the
 * caller (the repository's configured branch) — there is no main/master probe
 * anymore. Uses the ADO REST API with a PAT (Basic auth with :PAT).
 */
export async function openAdoPr(
  repoUrl: string,
  pat: string,
  organization: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<PrCreationResult> {
  const { project, repoName } = parseAdoUrl(repoUrl);
  const credentials = Buffer.from(`:${pat}`).toString("base64");
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
  };
  const baseUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repoName}`;

  const prRes = await fetch(`${baseUrl}/pullrequests?api-version=7.1`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sourceRefName: `refs/heads/${head}`,
      targetRefName: `refs/heads/${base}`,
      title,
      description: body,
    }),
  });

  if (!prRes.ok) {
    const errBody = await prRes.text();
    throw new Error(`ADO: Failed to create PR (${prRes.status}) — ${errBody}`);
  }

  const prData = (await prRes.json()) as { pullRequestId: number };
  const prUrl = `https://dev.azure.com/${organization}/${project}/_git/${repoName}/pullrequest/${prData.pullRequestId}`;
  return { prUrl };
}
