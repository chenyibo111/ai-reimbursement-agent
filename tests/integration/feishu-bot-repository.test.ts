import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { FeishuBotRepository } from "@/src/infrastructure/prisma/feishu-bot-repository";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const repository = new FeishuBotRepository(prisma);

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.inboundChannelEvent.deleteMany();
  await prisma.feishuConversation.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("deduplicates both repeated events and a redelivery with a different event ID", async () => {
  const first = await repository.recordInbound({
    eventId: "event-1",
    messageId: "om-1",
    messageType: "text",
    chatId: "oc-1",
    senderOpenId: "ou-1",
  });

  await expect(repository.recordInbound({
    eventId: "event-1",
    messageId: "om-1",
    messageType: "text",
    chatId: "oc-1",
    senderOpenId: "ou-1",
  })).resolves.toEqual({ id: first.id, shouldProcess: false });

  await expect(repository.recordInbound({
    eventId: "event-2",
    messageId: "om-1",
    messageType: "text",
    chatId: "oc-1",
    senderOpenId: "ou-1",
  })).resolves.toEqual({ id: first.id, shouldProcess: false });
});

it("claims an inbound event once and makes retryable events available again", async () => {
  const event = await repository.recordInbound({
    eventId: "event-1",
    messageId: "om-1",
    messageType: "text",
    chatId: "oc-1",
    senderOpenId: "ou-1",
  });

  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "PROCESSING" });
  await expect(repository.claimNextPending()).resolves.toBeNull();

  await repository.markRetryableFailure(event.id, "UNAVAILABLE");
  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "PROCESSING" });

  await repository.markProcessed(event.id);
  await expect(repository.claimNextPending()).resolves.toBeNull();
});

it("replaces a current claim per employee and chat without mixing employees in the same chat", async () => {
  const [employeeA, employeeB] = await Promise.all([
    prisma.employee.create({ data: { id: "employee-a", displayName: "员工 A", feishuUserId: "ou-a" } }),
    prisma.employee.create({ data: { id: "employee-b", displayName: "员工 B", feishuUserId: "ou-b" } }),
  ]);
  const [claimA1, claimA2, claimB] = await Promise.all([
    prisma.claimDraft.create({ data: { employeeId: employeeA.id } }),
    prisma.claimDraft.create({ data: { employeeId: employeeA.id } }),
    prisma.claimDraft.create({ data: { employeeId: employeeB.id } }),
  ]);

  await repository.setConversation(employeeA.id, "oc-shared", claimA1.id);
  await repository.setConversation(employeeB.id, "oc-shared", claimB.id);
  await repository.setConversation(employeeA.id, "oc-shared", claimA2.id);

  await expect(repository.getConversation(employeeA.id, "oc-shared")).resolves.toMatchObject({ claimId: claimA2.id });
  await expect(repository.getConversation(employeeB.id, "oc-shared")).resolves.toMatchObject({ claimId: claimB.id });
  await expect(repository.findEmployeeByOpenId("ou-a")).resolves.toEqual({ id: employeeA.id });
  await expect(repository.findEmployeeByOpenId("ou-missing")).resolves.toBeNull();
});
