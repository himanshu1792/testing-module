import { NextResponse } from "next/server";
import { listApplications, createApplication } from "@/lib/applications";

/**
 * Applications API — thin DB-only layer over lib/applications.
 * No pipeline/worker logic lives here.
 */

/** GET /api/applications -> all applications (no credentials) with run counts. */
export async function GET() {
  const applications = await listApplications();
  return NextResponse.json({ applications });
}

/**
 * POST /api/applications -> create an application.
 * Body: { name, testUrl, testUsername, testPassword } (all required).
 * Credentials are encrypted at rest by createApplication.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, testUrl, testUsername, testPassword } = body ?? {};

    if (!name || !testUrl || !testUsername || !testPassword) {
      return NextResponse.json(
        { error: "name, testUrl, testUsername, and testPassword are required" },
        { status: 400 }
      );
    }

    const application = await createApplication({
      name,
      testUrl,
      testUsername,
      testPassword,
    });

    return NextResponse.json(
      { application: { id: application.id, name: application.name, testUrl: application.testUrl } },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
