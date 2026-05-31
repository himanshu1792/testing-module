/**
 * Azure DevOps Work Item integration.
 * Fetches work items by ID or URL and extracts acceptance criteria.
 */

export interface AdoWorkItemResult {
  id: number;
  title: string;
  acceptanceCriteria: string | null;
  description: string | null;
}

/**
 * Parse an ADO work item reference into organization, project, and work item ID.
 *
 * Supported formats:
 *   - "AB#1234" or "1234" (needs org + project from repository context)
 *   - "https://dev.azure.com/{org}/{project}/_workitems/edit/{id}"
 *   - "https://{org}.visualstudio.com/{project}/_workitems/edit/{id}"
 */
export function parseAdoTicket(
  ticket: string,
  fallbackOrg?: string | null,
  fallbackProject?: string | null
): { organization: string; project: string; workItemId: number } {
  const trimmed = ticket.trim();

  // Try full URL first
  try {
    const url = new URL(trimmed);

    if (url.hostname === "dev.azure.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      const editIndex = segments.indexOf("edit");
      if (editIndex !== -1 && editIndex + 1 < segments.length) {
        const id = parseInt(segments[editIndex + 1], 10);
        if (isNaN(id)) throw new Error("Invalid work item ID in URL");
        return {
          organization: segments[0],
          project: segments[1],
          workItemId: id,
        };
      }
    }

    if (url.hostname.endsWith(".visualstudio.com")) {
      const org = url.hostname.replace(".visualstudio.com", "");
      const segments = url.pathname.split("/").filter(Boolean);
      const editIndex = segments.indexOf("edit");
      if (editIndex !== -1 && editIndex + 1 < segments.length) {
        const id = parseInt(segments[editIndex + 1], 10);
        if (isNaN(id)) throw new Error("Invalid work item ID in URL");
        return {
          organization: org,
          project: segments[0],
          workItemId: id,
        };
      }
    }

    throw new Error("Unrecognized ADO work item URL format");
  } catch (e) {
    if (!(e instanceof TypeError)) {
      if (e instanceof Error && !e.message.includes("Invalid URL")) throw e;
    }
  }

  const abMatch = trimmed.match(/^AB#(\d+)$/i);
  if (abMatch) {
    const id = parseInt(abMatch[1], 10);
    if (!fallbackOrg || !fallbackProject) {
      throw new Error(
        "AB#ID format requires an ADO repository with organization configured. Please use a full ADO work item URL instead."
      );
    }
    return { organization: fallbackOrg, project: fallbackProject, workItemId: id };
  }

  const numericMatch = trimmed.match(/^(\d+)$/);
  if (numericMatch) {
    const id = parseInt(numericMatch[1], 10);
    if (!fallbackOrg || !fallbackProject) {
      throw new Error(
        "Numeric work item ID requires an ADO repository with organization configured. Please use a full ADO work item URL instead."
      );
    }
    return { organization: fallbackOrg, project: fallbackProject, workItemId: id };
  }

  throw new Error(
    `Cannot parse ADO ticket reference: "${trimmed}". Use AB#1234, a numeric ID, or a full ADO work item URL.`
  );
}

/**
 * Fetch a work item from Azure DevOps and extract acceptance criteria.
 * Authentication: Basic auth with PAT (same PAT used for repository access).
 */
export async function fetchAdoWorkItem(
  organization: string,
  project: string,
  workItemId: number,
  pat: string
): Promise<AdoWorkItemResult> {
  const credentials = Buffer.from(`:${pat}`).toString("base64");

  const response = await fetch(
    `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/wit/workitems/${workItemId}?api-version=7.1&$expand=fields`,
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
      },
    }
  );

  if (response.status === 401) {
    throw new Error("ADO PAT is invalid or expired. Cannot fetch work item.");
  }

  if (response.status === 404) {
    throw new Error(`Work item #${workItemId} not found in ${organization}/${project}.`);
  }

  if (!response.ok) {
    throw new Error(`ADO API error ${response.status} fetching work item #${workItemId}.`);
  }

  const data = await response.json();
  const fields = data.fields || {};

  const title: string = fields["System.Title"] || `Work Item #${workItemId}`;
  const acceptanceCriteria: string | null =
    fields["Microsoft.VSTS.Common.AcceptanceCriteria"] || null;
  const description: string | null = fields["System.Description"] || null;

  return {
    id: workItemId,
    title,
    acceptanceCriteria,
    description,
  };
}

/**
 * Strip HTML tags from ADO rich-text fields and normalize whitespace.
 * ADO stores acceptance criteria and descriptions as HTML.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch acceptance criteria for an ADO ticket reference.
 * Returns a plain-text string combining acceptance criteria and description,
 * or null if nothing useful was found.
 */
export async function getAcceptanceCriteria(
  adoTicket: string,
  pat: string,
  fallbackOrg?: string | null,
  fallbackProject?: string | null
): Promise<{ title: string; criteria: string } | null> {
  const { organization, project, workItemId } = parseAdoTicket(
    adoTicket,
    fallbackOrg,
    fallbackProject
  );

  const workItem = await fetchAdoWorkItem(organization, project, workItemId, pat);

  const parts: string[] = [];

  if (workItem.acceptanceCriteria) {
    parts.push("## Acceptance Criteria\n" + stripHtml(workItem.acceptanceCriteria));
  }

  if (workItem.description) {
    parts.push("## Description\n" + stripHtml(workItem.description));
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    title: workItem.title,
    criteria: parts.join("\n\n"),
  };
}
