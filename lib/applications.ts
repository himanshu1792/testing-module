import { prisma } from "./prisma";
import { encrypt, decrypt } from "./encryption";

const DEFAULT_TENANT = "default";

export type ApplicationInput = {
  name: string;
  testUrl: string;
  testUsername: string;
  testPassword: string;
  tenantId?: string;
};

export type ApplicationView = {
  id: string;
  tenantId: string;
  name: string;
  testUrl: string;
  testUsername: string;
  testPassword: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ApplicationListItem = {
  id: string;
  name: string;
  testUrl: string;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Create a new application with encrypted credentials. */
export async function createApplication(input: ApplicationInput) {
  return prisma.application.create({
    data: {
      tenantId: input.tenantId ?? DEFAULT_TENANT,
      name: input.name,
      testUrl: input.testUrl,
      testUsername: encrypt(input.testUsername),
      testPassword: encrypt(input.testPassword),
    },
  });
}

/** List applications (no credentials) with their task run counts. */
export async function listApplications(
  tenantId: string = DEFAULT_TENANT
): Promise<ApplicationListItem[]> {
  const apps = await prisma.application.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      testUrl: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { tasks: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return apps.map((app) => ({
    id: app.id,
    name: app.name,
    testUrl: app.testUrl,
    runCount: app._count.tasks,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  }));
}

/** Get a single application by ID with decrypted credentials. */
export async function getApplication(id: string): Promise<ApplicationView | null> {
  const app = await prisma.application.findUnique({ where: { id } });
  if (!app) return null;
  return {
    ...app,
    testUsername: decrypt(app.testUsername),
    testPassword: decrypt(app.testPassword),
  };
}

/** Update an application; only encrypts credential fields that are provided. */
export async function updateApplication(id: string, input: Partial<ApplicationInput>) {
  const data: Record<string, string> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.testUrl !== undefined) data.testUrl = input.testUrl;
  if (input.testUsername !== undefined) data.testUsername = encrypt(input.testUsername);
  if (input.testPassword !== undefined) data.testPassword = encrypt(input.testPassword);

  return prisma.application.update({ where: { id }, data });
}

/** Delete an application by ID (cascades to repositories and tasks). */
export async function deleteApplication(id: string) {
  return prisma.application.delete({ where: { id } });
}
