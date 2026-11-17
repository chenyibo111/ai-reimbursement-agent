import { afterAll, beforeAll, expect, it } from "vitest";
import { AgentEventNotificationSnapshotRepository } from "@/src/infrastructure/prisma/agent-event-notification-snapshot-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test");
beforeAll(async () => prisma.$connect());
afterAll(async () => prisma.$disconnect());

it("keeps the first rendered message and template version for an event id", async () => {
  const repository = new AgentEventNotificationSnapshotRepository(prisma);
  const eventId = `notification-snapshot-${crypto.randomUUID()}`;
  const first = { eventId, version: 2, enabled: true, text: "版本 2 的通知" };
  expect(await repository.getOrCreate(first)).toMatchObject(first);
  expect(await repository.getOrCreate({ eventId, version: 3, enabled: true, text: "版本 3 的通知" })).toMatchObject(first);
  expect(await repository.find(eventId)).toMatchObject(first);
  await prisma.agentEventNotificationSnapshot.delete({ where: { eventId } });
});
