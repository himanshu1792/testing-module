import { prisma } from "../prisma";
import { getTask } from "../tasks";
import { getApplication } from "../applications";
import { getRepository } from "../repositories";
import { workspacePathFor } from "../workspace";
import { syncWorkspace } from "../workspace-git";
import { runPlanner } from "../agents/regression/planner";
import { runGenerator } from "../agents/regression/generator";
import { runHealer } from "../agents/regression/healer";
import { runPrCreator } from "../agents/pr-creator";
import type { HeadlessContext } from "./context";

/**
 * Headless exploratory pipeline.
 *
 * The task input is the target URL to explore (not a scenario). Resolves the
 * task + decrypted app/repo, then runs planner -> generator -> healer ->
 * pr-creator sequentially, persisting each artifact as it is produced.
 *
 * STATUS OWNERSHIP: the worker owns status/startedAt/finishedAt transitions.
 * This function only updates `stage` (via ctx.log) and the artifact columns,
 * and lets exceptions propagate so the worker can mark the task failed.
 */
export async function runExploratoryPipeline(taskId: string): Promise<void> {
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

  const log = (stage: string, message: string): void => {
    void prisma.testTask.update({ where: { id: taskId }, data: { stage } }).catch(() => {});
    console.log(`[${taskId}] ${stage}: ${message}`);
  };

  const workspacePath = workspacePathFor(application.name);

  const ctx: HeadlessContext = {
    taskId,
    kind: "exploratory",
    inputText: task.inputText,
    targetUrl: task.inputText, // exploratory: inputText IS the target URL
    acceptanceCriteria: null,
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

  // --- Planner ---
  const testPlan = await runPlanner(ctx);
  await prisma.testTask.update({ where: { id: taskId }, data: { testPlan } });

  // --- Generator ---
  const script = await runGenerator(ctx, testPlan);
  await prisma.testTask.update({ where: { id: taskId }, data: { generatedScript: script } });

  // --- Healer ---
  const healed = await runHealer(ctx, script);
  await prisma.testTask.update({ where: { id: taskId }, data: { generatedScript: healed } });

  // --- PR Creator ---
  const prUrl = await runPrCreator(ctx, healed, "exploratory");
  await prisma.testTask.update({ where: { id: taskId }, data: { prUrl } });
}
