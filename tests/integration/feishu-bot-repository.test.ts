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

it("releases an event left processing by a stopped Worker so the next Worker can reclaim it", async () => {
  const event = await repository.recordInbound({
    eventId: "event-restart",
    messageId: "om-restart",
    messageType: "text",
    chatId: "oc-1",
    senderOpenId: "ou-1",
  });
  await expect(repository.claimNextPending()).resolves.toMatchObject({ eventId: "event-restart", status: "PROCESSING" });

  await expect(repository.recoverProcessingEvents()).resolves.toMatchObject({ recovered: 0 });
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { updatedAt: new Date(Date.now() - 3 * 60_000) } });
  await repository.recoverProcessingEvents();

  await expect(repository.claimNextPending()).resolves.toMatchObject({ eventId: "event-restart", status: "PROCESSING" });
});

it("keeps a completed business reply durable across delivery failure and worker restart", async () => {
  const event = await repository.recordInbound({ eventId: "event-delivery", messageId: "om-delivery", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1" });
  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "PROCESSING", attemptCount: 1 });
  await repository.markReplyPending(event.id, "报销已保存");

  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "REPLY_PROCESSING", replyText: "报销已保存", deliveryAttemptCount: 1 });
  await repository.markReplyRetryableFailure(event.id, "UNAVAILABLE");
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { nextDeliveryAttemptAt: new Date(0) } });
  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "REPLY_PROCESSING", deliveryAttemptCount: 2, attemptCount: 1 });

  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { updatedAt: new Date(Date.now() - 3 * 60_000) } });
  await repository.recoverProcessingEvents();
  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "REPLY_PROCESSING", deliveryAttemptCount: 3, attemptCount: 1 });
  await repository.markReplyDelivered(event.id);
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await expect(prisma.inboundChannelEvent.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({ status: "PROCESSED", replyText: "报销已保存", failureCode: null, deliveredAt: expect.any(Date) });
});

it("keeps a terminal delivery failure visible for operator repair", async () => {
  const event = await repository.recordInbound({ eventId: "event-terminal", messageId: "om-terminal", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1" });
  await repository.claimNextPending();
  await repository.markReplyPending(event.id, "处理结果");
  await repository.claimNextPending();
  await repository.markReplyFailed(event.id, "UNAUTHORIZED");
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await expect(prisma.inboundChannelEvent.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({ status: "REPLY_FAILED", failureCode: "UNAUTHORIZED", deliveredAt: null });
});

it("does not automatically resend an ambiguous reply after Feishu's deduplication window", async () => {
  const event = await repository.recordInbound({ eventId: "event-old-send", messageId: "om-old-send", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1" });
  await repository.claimNextPending();
  await repository.markReplyPending(event.id, "已提交");
  await repository.claimNextPending();
  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { updatedAt: new Date(Date.now() - 56 * 60_000) } });

  await expect(repository.recoverProcessingEvents()).resolves.toMatchObject({ uncertainDeliveryFailed: 1 });
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await expect(prisma.inboundChannelEvent.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({ status: "REPLY_FAILED", failureCode: "DELIVERY_OUTCOME_UNKNOWN" });
});

it("keeps a known failed delivery retryable after a long worker outage", async () => {
  const event = await repository.recordInbound({ eventId: "event-old-retry", messageId: "om-old-retry", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1" });
  await repository.claimNextPending();
  await repository.markReplyPending(event.id, "已保存");
  await repository.claimNextPending();
  await repository.markReplyRetryableFailure(event.id, "REJECTED");
  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { updatedAt: new Date(Date.now() - 56 * 60_000), nextDeliveryAttemptAt: new Date(0) } });

  await expect(repository.recoverProcessingEvents()).resolves.toMatchObject({ uncertainDeliveryFailed: 0 });
  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "REPLY_PROCESSING", deliveryAttemptCount: 2, attemptCount: 1 });
});

it("stops an old retry after a transport failure whose delivery outcome is unknown", async () => {
  const event = await repository.recordInbound({ eventId: "event-unknown-retry", messageId: "om-unknown-retry", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1" });
  await repository.claimNextPending();
  await repository.markReplyPending(event.id, "已保存");
  await repository.claimNextPending();
  await repository.markReplyRetryableFailure(event.id, "UNAVAILABLE");
  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { updatedAt: new Date(Date.now() - 56 * 60_000), nextDeliveryAttemptAt: new Date(0) } });

  await expect(repository.recoverProcessingEvents()).resolves.toMatchObject({ uncertainDeliveryFailed: 1 });
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await expect(prisma.inboundChannelEvent.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({ status: "REPLY_FAILED", failureCode: "DELIVERY_OUTCOME_UNKNOWN" });
});

it("reclaims a stuck delivery only after its processing lease has expired", async () => {
  const event = await repository.recordInbound({ eventId: "event-lease", messageId: "om-lease", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1" });
  await repository.claimNextPending();
  await repository.markReplyPending(event.id, "结果");
  await repository.claimNextPending();

  await expect(repository.recoverProcessingEvents(new Date(Date.now() - 2 * 60_000))).resolves.toMatchObject({ recovered: 0 });
  await expect(repository.claimNextPending()).resolves.toBeNull();
  await prisma.inboundChannelEvent.update({ where: { id: event.id }, data: { updatedAt: new Date(Date.now() - 3 * 60_000) } });
  await expect(repository.recoverProcessingEvents(new Date(Date.now() - 2 * 60_000))).resolves.toMatchObject({ recovered: 1 });
  await expect(repository.claimNextPending()).resolves.toMatchObject({ id: event.id, status: "REPLY_PROCESSING", attemptCount: 1, deliveryAttemptCount: 2 });
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
});
