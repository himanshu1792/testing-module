// Prisma Client singleton. Shared by the Next.js app and the standalone worker.
// The globalThis guard prevents connection-pool exhaustion during dev hot-reload.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * Extract the `?schema=` param from DATABASE_URL. Prisma Migrate honors this
 * convention, but node-postgres does NOT — so we must apply it ourselves on the
 * runtime connection (see below) to keep migrations and queries on one schema.
 */
function parseSchema(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).searchParams.get("schema") ?? undefined;
  } catch {
    return undefined;
  }
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL!;
  const schema = parseSchema(connectionString);

  // Two layers keep us on the isolated schema:
  //  1. The pool `options` set search_path so RAW SQL (lib/queue.ts uses
  //     unqualified "TestTask") resolves to <schema> rather than public.
  //  2. The adapter `schema` option qualifies Prisma-generated queries to
  //     <schema> (via getConnectionInfo().schemaName).
  const adapter = schema
    ? new PrismaPg(
        { connectionString, options: `-c search_path=${schema},public` },
        { schema }
      )
    : new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
