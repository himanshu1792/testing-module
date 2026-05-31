import { NextRequest, NextResponse } from "next/server";
import {
  listRepositories,
  listAllRepositoriesGrouped,
  createRepository,
  validateGitHubPat,
  validateAdoPat,
  type ValidationResult,
} from "@/lib/repositories";

/**
 * Repositories API — thin DB-only layer over lib/repositories.
 * PAT validation is performed inline before persisting; no worker logic here.
 */

/**
 * GET /api/repositories
 *   ?applicationId=... -> { repositories } for that application
 *   (omitted)          -> { grouped }      keyed by applicationId
 */
export async function GET(request: NextRequest) {
  const applicationId = request.nextUrl.searchParams.get("applicationId");
  if (applicationId) {
    const repositories = await listRepositories(applicationId);
    return NextResponse.json({ repositories });
  }
  const grouped = await listAllRepositoriesGrouped();
  return NextResponse.json({ grouped });
}

/**
 * POST /api/repositories -> validate the PAT, then create the repository.
 * Body: { provider, repoUrl, pat, organization, outputFolder, applicationId }.
 * provider "github" -> validateGitHubPat; "ado" -> requires organization then
 * validateAdoPat. On invalid PAT (or bad URL) returns 400 { error }.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { provider, repoUrl, pat, organization, outputFolder, applicationId } =
      body ?? {};

    // Validate the PAT FIRST — never persist credentials we can't authenticate.
    let result: ValidationResult;
    if (provider === "github") {
      result = await validateGitHubPat(repoUrl, pat);
    } else if (provider === "ado") {
      if (!organization) {
        return NextResponse.json(
          { error: "organization is required for Azure DevOps repositories" },
          { status: 400 }
        );
      }
      result = await validateAdoPat(repoUrl, pat, organization);
    } else {
      return NextResponse.json(
        { error: "provider must be 'github' or 'ado'" },
        { status: 400 }
      );
    }

    if (!result.valid) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const repository = await createRepository({
      provider,
      repoUrl,
      pat,
      organization: organization ?? null,
      outputFolder,
      applicationId,
    });

    return NextResponse.json(
      { repository: { id: repository.id, provider: repository.provider, repoUrl: repository.repoUrl } },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
