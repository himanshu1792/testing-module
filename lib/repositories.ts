import { prisma } from "./prisma";
import { encrypt, decrypt } from "./encryption";
import { parseGitHubUrl, parseAdoUrl } from "./repository-utils";

const DEFAULT_TENANT = "default";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export type RepositoryInput = {
  provider: string;
  repoUrl: string;
  pat: string;
  organization: string | null;
  outputFolder: string;
  branch: string;
  applicationId: string;
  tenantId?: string;
};

export type RepositoryView = {
  id: string;
  tenantId: string;
  provider: string;
  repoUrl: string;
  pat: string;
  organization: string | null;
  outputFolder: string;
  branch: string;
  applicationId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type RepositoryListItem = {
  id: string;
  provider: string;
  repoUrl: string;
  organization: string | null;
  outputFolder: string;
  branch: string;
  applicationId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Repositories grouped by applicationId for the dependent dropdown in the Run tab. */
export type GroupedRepositories = Record<
  string,
  Array<{ id: string; provider: string; repoUrl: string }>
>;

// --- PAT Validation ---

/** Validate a GitHub PAT by hitting the repo API. */
export async function validateGitHubPat(
  repoUrl: string,
  pat: string
): Promise<ValidationResult> {
  const { owner, repo } = parseGitHubUrl(repoUrl);

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 401) {
    return { valid: false, error: "Invalid PAT. Check that the token is correct and not expired." };
  }

  if (response.status === 404) {
    const scopes = response.headers.get("X-OAuth-Scopes") || "";
    if (!scopes.includes("repo")) {
      return { valid: false, error: "PAT needs 'repo' scope. Current scopes: " + (scopes || "none") };
    }
    return { valid: false, error: "Repository not found. Verify the URL is correct." };
  }

  if (!response.ok) {
    return { valid: false, error: `GitHub API error: ${response.status}` };
  }

  const scopes = response.headers.get("X-OAuth-Scopes") || "";
  if (scopes && !scopes.includes("repo")) {
    return { valid: false, error: "PAT needs 'repo' scope for full access. Current scopes: " + scopes };
  }

  return { valid: true };
}

/** Validate an Azure DevOps PAT. Uses Basic auth with base64(":PAT"). */
export async function validateAdoPat(
  repoUrl: string,
  pat: string,
  organization: string
): Promise<ValidationResult> {
  const { project, repoName } = parseAdoUrl(repoUrl);
  const credentials = Buffer.from(`:${pat}`).toString("base64");

  const response = await fetch(
    `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repoName}?api-version=7.1`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (response.status === 401) {
    return { valid: false, error: "Invalid PAT. Check that the token is correct and not expired." };
  }
  if (response.status === 403) {
    return { valid: false, error: "PAT needs 'Code (Read & Write)' scope. Check your token permissions." };
  }
  if (response.status === 404) {
    return { valid: false, error: "Repository not found. Verify the URL, organization, and project name." };
  }
  if (!response.ok) {
    return { valid: false, error: `Azure DevOps API error: ${response.status}` };
  }

  return { valid: true };
}

// --- CRUD ---

/** Create a new repository with encrypted PAT. */
export async function createRepository(input: RepositoryInput) {
  return prisma.repository.create({
    data: {
      tenantId: input.tenantId ?? DEFAULT_TENANT,
      provider: input.provider,
      repoUrl: input.repoUrl,
      pat: encrypt(input.pat),
      organization: input.organization,
      outputFolder: input.outputFolder,
      branch: input.branch ?? "main",
      applicationId: input.applicationId,
    },
  });
}

/** List repositories for an application (PAT excluded). */
export async function listRepositories(applicationId: string): Promise<RepositoryListItem[]> {
  return prisma.repository.findMany({
    where: { applicationId },
    select: {
      id: true,
      provider: true,
      repoUrl: true,
      organization: true,
      outputFolder: true,
      branch: true,
      applicationId: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/** All repositories for a tenant grouped by applicationId (for the Run tab dropdown). */
export async function listAllRepositoriesGrouped(
  tenantId: string = DEFAULT_TENANT
): Promise<GroupedRepositories> {
  const repos = await prisma.repository.findMany({
    where: { tenantId },
    select: { id: true, provider: true, repoUrl: true, applicationId: true },
  });

  const grouped: GroupedRepositories = {};
  for (const repo of repos) {
    (grouped[repo.applicationId] ??= []).push({
      id: repo.id,
      provider: repo.provider,
      repoUrl: repo.repoUrl,
    });
  }
  return grouped;
}

/** Get a single repository by ID with decrypted PAT. */
export async function getRepository(id: string): Promise<RepositoryView | null> {
  const repo = await prisma.repository.findUnique({ where: { id } });
  if (!repo) return null;
  return { ...repo, pat: decrypt(repo.pat) };
}

/** Delete a repository by ID. */
export async function deleteRepository(id: string) {
  return prisma.repository.delete({ where: { id } });
}
