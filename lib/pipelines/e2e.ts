import { prisma } from "../prisma";
import { getTask } from "../tasks";
import { getApplication } from "../applications";
import { getRepository } from "../repositories";
import { getAcceptanceCriteria } from "../ado-work-items";
import { parseAdoUrl } from "../repository-utils";
import { workspacePathFor } from "../workspace";
import { syncWorkspace } from "../workspace-git";
import { runPromptBuilder } from "../agents/prompt-builder";
import { runScriptGenerator } from "../agents/script-generator";
import { runReviewer } from "../agents/reviewer";
import { runPrCreator } from "../agents/pr-creator";
import type { HeadlessContext } from "./context";

/**
 * Headless E2E pipeline.
 *
 * Resolves the task + decrypted app/repo, optionally fetches ADO acceptance
 * criteria, then runs prompt-builder -> script-generator -> reviewer ->
 * pr-creator sequentially, persisting each artifact as it is produced.
 *
 * STATUS OWNERSHIP: the worker owns status/startedAt/finishedAt transitions.
 * This function only updates `stage` (via ctx.log) and the artifact columns,
 * and lets exceptions propagate so the worker can mark the task failed.
 */
export async function runE2EPipeline(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const application = await getApplication(task.applicationId);
  if (!application) {
    throw new Error(`Application not found: ${task.applicationId}`);
  }

  const repository = await getRepository(task.repositoryId);
  if (!repository) {
    throw new Error(`Repository not found: ${task.repositoryId}`);
  }

  // --- Best-effort ADO acceptance criteria fetch (never fatal) ---
  let acceptanceCriteria: { title: string; criteria: string } | null = null;
  if (task.adoTicket) {
    try {
      let fallbackProject: string | null = null;
      if (repository.provider === "ado") {
        try {
          fallbackProject = parseAdoUrl(repository.repoUrl).project;
        } catch {
          // Non-critical — full-URL tickets still resolve without a fallback.
        }
      }
      acceptanceCriteria = await getAcceptanceCriteria(
        task.adoTicket,
        repository.pat,
        repository.organization,
        fallbackProject
      );
    } catch {
      acceptanceCriteria = null;
    }
  }

  const log = (stage: string, message: string): void => {
    void prisma.testTask.update({ where: { id: taskId }, data: { stage } }).catch(() => {});
    console.log(`[${taskId}] ${stage}: ${message}`);
  };

  const workspacePath = workspacePathFor(application.name);

  const ctx: HeadlessContext = {
    taskId,
    kind: "e2e",
    inputText: task.inputText,
    targetUrl: application.testUrl,
    acceptanceCriteria,
    applicationName: application.name,
    applicationUrl: application.testUrl,
    applicationUsername: application.testUsername,
    applicationPassword: application.testPassword,
    repositoryUrl: repository.repoUrl,
    repositoryProvider: repository.provider,
    outputFolder: repository.outputFolder,
    repositoryPat: repository.pat,
    repositoryOrganization: repository.organization,
    branch: repository.branch,
    workspacePath,
    log,
  };

  // --- Pre-hook: stash local changes + pull latest from the target branch ---
  ctx.log("workspace_sync", `Syncing ${workspacePath} (branch ${repository.branch})`);
  await syncWorkspace({
    workspacePath,
    repoUrl: repository.repoUrl,
    provider: repository.provider,
    pat: repository.pat,
    organization: repository.organization,
    branch: repository.branch,
  });

  // --- Prompt Builder ---
  const refinedPrompt = await runPromptBuilder(ctx);
  await prisma.testTask.update({ where: { id: taskId }, data: { refinedPrompt } });

  // --- Script Generator ---
  const script = await runScriptGenerator(ctx, refinedPrompt);
  await prisma.testTask.update({ where: { id: taskId }, data: { generatedScript: script } });

  // --- Reviewer ---
  const reviewed = await runReviewer(ctx, script);
  await prisma.testTask.update({ where: { id: taskId }, data: { generatedScript: reviewed } });

  // --- PR Creator ---
  const prUrl = await runPrCreator(ctx, reviewed, "e2e");
  await prisma.testTask.update({ where: { id: taskId }, data: { prUrl } });
}
