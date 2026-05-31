import { prisma } from "./prisma";

const DEFAULT_TENANT = "default";

export type TaskKind = "e2e" | "exploratory";

export type CreateTaskInput = {
  kind: TaskKind;
  /** e2e: plain-English scenario. exploratory: target URL to explore. */
  inputText: string;
  applicationId: string;
  repositoryId: string;
  adoTicket?: string | null;
  tenantId?: string;
};

export type TaskListItem = {
  id: string;
  kind: string;
  inputText: string;
  status: string;
  stage: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  applicationId: string;
  repositoryId: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  application: { name: string };
  repository: { provider: string; repoUrl: string };
};

/** Create a queued task. The worker will claim and run it. */
export async function createTask(input: CreateTaskInput) {
  return prisma.testTask.create({
    data: {
      tenantId: input.tenantId ?? DEFAULT_TENANT,
      kind: input.kind,
      inputText: input.inputText,
      adoTicket: input.adoTicket ?? null,
      status: "queued",
      applicationId: input.applicationId,
      repositoryId: input.repositoryId,
    },
  });
}

/** List tasks (most recent first) for the Previous Runs tab. */
export async function listTasks(tenantId: string = DEFAULT_TENANT): Promise<TaskListItem[]> {
  return prisma.testTask.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      kind: true,
      inputText: true,
      status: true,
      stage: true,
      prUrl: true,
      errorMessage: true,
      applicationId: true,
      repositoryId: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      finishedAt: true,
      application: { select: { name: true } },
      repository: { select: { provider: true, repoUrl: true } },
    },
  }) as Promise<TaskListItem[]>;
}

/** Get the raw task row (used by the worker to resolve app + repo). */
export async function getTask(id: string) {
  return prisma.testTask.findUnique({ where: { id } });
}
