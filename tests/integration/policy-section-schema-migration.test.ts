import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
class RollbackFixture extends Error {}

beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());

it("relocates a policy section table created in the connection user's schema to public", async () => {
  let moved = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE SCHEMA "policy_section_migration_fixture"');
      await tx.$executeRawUnsafe('ALTER TABLE public."PolicySection" SET SCHEMA "policy_section_migration_fixture"');
      const before = await tx.$queryRaw<Array<{ table_name: string | null }>>`SELECT to_regclass('public."PolicySection"')::text AS table_name`;
      expect(before[0]?.table_name).toBeNull();

      const sql = await readFile(path.resolve("prisma/migrations/20261026000000_policy_section_public_schema/migration.sql"), "utf8");
      await tx.$executeRawUnsafe(sql);
      const after = await tx.$queryRaw<Array<{ table_name: string | null }>>`SELECT to_regclass('public."PolicySection"')::text AS table_name`;
      expect(after[0]?.table_name).not.toBeNull();
      moved = true;
      throw new RollbackFixture();
    }, { timeout: 10_000 });
  } catch (error) {
    if (!(error instanceof RollbackFixture)) throw error;
  }
  expect(moved).toBe(true);
});

it("leaves an existing public policy section table in place", async () => {
  const sql = await readFile(path.resolve("prisma/migrations/20261026000000_policy_section_public_schema/migration.sql"), "utf8");
  await prisma.$transaction(async (tx) => {
    const before = await tx.$queryRaw<Array<{ table_oid: number | null }>>`SELECT to_regclass('public."PolicySection"')::oid AS table_oid`;
    await tx.$executeRawUnsafe(sql);
    const after = await tx.$queryRaw<Array<{ table_oid: number | null }>>`SELECT to_regclass('public."PolicySection"')::oid AS table_oid`;
    expect(after[0]?.table_oid).toBe(before[0]?.table_oid);
  });
});
