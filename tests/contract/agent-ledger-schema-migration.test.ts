import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

const migrationPath = resolve("prisma/migrations/20261009095500_move_agent_ledgers_to_public_schema/migration.sql");

it("moves Agent-owned ledgers out of the reimbursement schema", () => {
  expect(existsSync(migrationPath)).toBe(true);

  const migration = readFileSync(migrationPath, "utf8");
  expect(migration).toContain('ALTER TABLE IF EXISTS reimbursement."AgentToolCall" SET SCHEMA public;');
  expect(migration).toContain('ALTER TABLE IF EXISTS reimbursement."AgentProcessedEvent" SET SCHEMA public;');
});
