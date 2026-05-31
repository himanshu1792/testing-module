import { parseGitHubUrl, parseAdoUrl } from "../repository-utils";

export interface PrCreationResult {
  prUrl: string;
}

// ──────────────── GitHub ────────────────

/**
 * Create a branch, commit a file, and open a PR on GitHub.
 * Uses the GitHub REST API with a Personal Access Token (Bearer auth).
 */
export async function createGitHubPr(
  repoUrl: string,
  pat: string,
  branchName: string,
  filePath: string,
  fileContent: string,
  prTitle: string,
  prBody: string
): Promise<PrCreationResult> {
  const { owner, repo } = parseGitHubUrl(repoUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

  // 1. Get default branch and its HEAD SHA
  const repoRes = await fetch(baseUrl, { headers });
  if (!repoRes.ok) {
    throw new Error(`GitHub: Failed to get repo info (${repoRes.status})`);
  }
  const repoData = (await repoRes.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  const refRes = await fetch(`${baseUrl}/git/ref/heads/${defaultBranch}`, { headers });
  if (!refRes.ok) {
    throw new Error(`GitHub: Failed to get HEAD ref (${refRes.status})`);
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const baseSha = refData.object.sha;

  // 2. Create branch (422 = already exists, which is fine/idempotent)
  const createRefRes = await fetch(`${baseUrl}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  if (!createRefRes.ok && createRefRes.status !== 422) {
    throw new Error(`GitHub: Failed to create branch (${createRefRes.status})`);
  }

  // 3. Create file on branch
  const contentB64 = Buffer.from(fileContent, "utf-8").toString("base64");
  const createFileRes = await fetch(`${baseUrl}/contents/${filePath}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `test: add ${filePath.split("/").pop()} via headless TestForge`,
      content: contentB64,
      branch: branchName,
    }),
  });
  if (!createFileRes.ok) {
    throw new Error(`GitHub: Failed to create file (${createFileRes.status})`);
  }

  // 4. Create pull request
  const prRes = await fetch(`${baseUrl}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: prTitle,
      body: prBody,
      head: branchName,
      base: defaultBranch,
    }),
  });
  if (!prRes.ok) {
    throw new Error(`GitHub: Failed to create PR (${prRes.status})`);
  }
  const prData = (await prRes.json()) as { html_url: string };

  return { prUrl: prData.html_url };
}

// ──────────────── Azure DevOps ────────────────

/**
 * Create a branch, push a file, and open a PR on Azure DevOps.
 * Uses the ADO REST API with a Personal Access Token (Basic auth with :PAT).
 */
export async function createAdoPr(
  repoUrl: string,
  pat: string,
  organization: string,
  branchName: string,
  filePath: string,
  fileContent: string,
  prTitle: string,
  prBody: string
): Promise<PrCreationResult> {
  const { project, repoName } = parseAdoUrl(repoUrl);
  const ZERO_SHA = "0000000000000000000000000000000000000000";
  const credentials = Buffer.from(`:${pat}`).toString("base64");
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
  };
  const baseUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repoName}`;

  // 1. Get default branch ref (try main first, then master)
  let defaultRef = await findDefaultRef(baseUrl, headers, "main");
  if (!defaultRef) {
    defaultRef = await findDefaultRef(baseUrl, headers, "master");
  }
  if (!defaultRef) {
    throw new Error("ADO: Could not find default branch (main or master)");
  }
  const defaultBranchName = defaultRef.name;

  // If a rerun uses the same branch name, update from current branch tip.
  const existingSourceRef = await findDefaultRef(baseUrl, headers, branchName);
  const sourceOldObjectId = existingSourceRef?.objectId ?? ZERO_SHA;

  // 2. Create branch + push file in a single push operation
  const pushRes = await fetch(`${baseUrl}/pushes?api-version=7.1`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      refUpdates: [{ name: `refs/heads/${branchName}`, oldObjectId: sourceOldObjectId }],
      commits: [
        {
          comment: `test: add ${filePath.split("/").pop()} via headless TestForge`,
          changes: [
            {
              changeType: "add",
              item: { path: `/${filePath}` },
              newContent: { content: fileContent, contentType: "rawtext" },
            },
          ],
        },
      ],
    }),
  });

  if (!pushRes.ok) {
    const errBody = await pushRes.text();
    throw new Error(`ADO: Failed to push (${pushRes.status}) — ${errBody}`);
  }

  // 3. Create pull request
  const prRes = await fetch(`${baseUrl}/pullrequests?api-version=7.1`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sourceRefName: `refs/heads/${branchName}`,
      targetRefName: defaultBranchName,
      title: prTitle,
      description: prBody,
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

// ──────────────── Helpers ────────────────

interface AdoRef {
  name: string;
  objectId: string;
}

async function findDefaultRef(
  baseUrl: string,
  headers: Record<string, string>,
  branchName: string
): Promise<AdoRef | null> {
  const res = await fetch(
    `${baseUrl}/refs?filter=heads/${branchName}&api-version=7.1`,
    { headers }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { value: AdoRef[] };
  return data.value?.[0] ?? null;
}
