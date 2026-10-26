import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const repository = new AgentConversationRepository(prisma);

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

let employeeSequence = 0;

async function createEmployee() {
  employeeSequence += 1;
  return prisma.employee.create({
    data: { id: `agent-conversation-${Date.now()}-${employeeSequence}`, displayName: "员工 A" },
  });
}

describe("AgentConversationRepository", () => {
  it("consumes a pending receipt deletion at most once", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const action = { kind: "DELETE_RECEIPT" as const, claimId: "claim-1", claimVersion: 3, receiptId: "receipt-2", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await repository.setPendingAction({ conversationId: conversation.id, action });
    expect(await repository.consumePendingAction({ conversationId: conversation.id, action })).toBe(true);
    expect(await repository.consumePendingAction({ conversationId: conversation.id, action })).toBe(false);
    await expect(repository.getConversationByIdOrThrow(conversation.id)).resolves.toMatchObject({ pendingAction: null });
  });
  it("persists an edit target independently of read selection and active Intake", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id, claimId: "active-go-claim" });
    await repository.setSelectedReadClaimId({ conversationId: conversation.id, claimId: "read-go-claim" });
    await repository.setSelectedEditClaimId({ conversationId: conversation.id, claimId: "edit-go-claim" });
    await expect(repository.getConversationByIdOrThrow(conversation.id)).resolves.toMatchObject({ selectedReadClaimId: "read-go-claim", selectedEditClaimId: "edit-go-claim" });
    await expect(repository.getCurrentIntake(employee.id)).resolves.toMatchObject({ id: intake.id, claimId: "active-go-claim" });
  });
  it("persists a bounded search page independently of the active intake", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id, claimId: "active-claim" });
    const state = { query: { status: "DRAFT" as const }, remaining: 2, cursor: "cursor", totalCount: 12, expiresAt: new Date(Date.now()+600_000).toISOString(), lastPage: [{ ordinal: 1, id: "old-claim", claimNumber: "BX20261026-0001" }] };
    await repository.setSearchState({ conversationId: conversation.id, state });
    await expect(repository.getConversationByIdOrThrow(conversation.id)).resolves.toMatchObject({ searchState: state });
    await expect(repository.getCurrentIntake(employee.id)).resolves.toMatchObject({ id: intake.id, claimId: "active-claim" });
    await repository.setSearchState({ conversationId: conversation.id, state: null });
    await expect(repository.getConversationByIdOrThrow(conversation.id)).resolves.toMatchObject({ searchState: null });
  });
  it("persists a private read selection separately from active intake and group chat", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const group = await repository.getOrCreateGroup(employee.id, `oc-read-${employee.id}`);
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id, claimId: "active-go-claim" });
    await repository.setSelectedReadClaimId({ conversationId: conversation.id, claimId: "old-go-claim" });
    await expect(repository.getConversationByIdOrThrow(conversation.id)).resolves.toMatchObject({ selectedReadClaimId: "old-go-claim" });
    await expect(repository.getCurrentIntake(employee.id)).resolves.toMatchObject({ id: intake.id, claimId: "active-go-claim" });
    await expect(repository.getConversationByIdOrThrow(group.id)).resolves.toMatchObject({ selectedReadClaimId: null });
    await repository.setSelectedReadClaimId({ conversationId: conversation.id, claimId: null });
    await expect(repository.getConversationByIdOrThrow(conversation.id)).resolves.toMatchObject({ selectedReadClaimId: null });
  });
  it("shares an employee private conversation between Web and Feishu but isolates group conversations", async () => {
    const employee = await createEmployee();

    const [webPrivate, feishuPrivate, groupA, groupB] = await Promise.all([
      repository.getOrCreatePrivate(employee.id),
      repository.getOrCreatePrivate(employee.id),
      repository.getOrCreateGroup(employee.id, "oc-group-a"),
      repository.getOrCreateGroup(employee.id, "oc-group-b"),
    ]);

    expect(webPrivate.id).toBe(feishuPrivate.id);
    expect(webPrivate.kind).toBe("PRIVATE");
    expect(groupA.id).not.toBe(webPrivate.id);
    expect(groupA.id).not.toBe(groupB.id);
    expect(groupA.kind).toBe("GROUP");
  });

  it("deduplicates channel messages and allocates a monotonic sequence", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);

    const first = await repository.appendMessage({
      conversationId: conversation.id,
      role: "USER",
      channel: "FEISHU",
      channelMessageId: `om-${employee.id}`,
      text: "开始报销",
    });
    const duplicate = await repository.appendMessage({
      conversationId: conversation.id,
      role: "USER",
      channel: "FEISHU",
      channelMessageId: `om-${employee.id}`,
      text: "开始报销",
    });
    const second = await repository.appendMessage({
      conversationId: conversation.id,
      role: "ASSISTANT",
      channel: "FEISHU",
      text: "请上传票据。",
    });

    expect(duplicate).toMatchObject({ id: first.id, sequence: 1 });
    expect(second.sequence).toBe(2);
    await expect(repository.listMessages({ conversationId: conversation.id })).resolves.toMatchObject([
      { id: first.id, sequence: 1 },
      { id: second.id, sequence: 2 },
    ]);
  });

  it("finds the assistant reply that is explicitly linked to an inbound message", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const firstInboundId = `om-first-${employee.id}`;
    const secondInboundId = `om-second-${employee.id}`;
    await repository.appendMessage({ conversationId: conversation.id, role: "USER", channel: "FEISHU", channelMessageId: firstInboundId, text: "第一条" });
    await repository.appendMessage({ conversationId: conversation.id, role: "USER", channel: "FEISHU", channelMessageId: secondInboundId, text: "第二条" });
    await repository.appendMessage({ conversationId: conversation.id, role: "ASSISTANT", channel: "FEISHU", inReplyToChannelMessageId: secondInboundId, text: "第二条回复" });
    await repository.appendMessage({ conversationId: conversation.id, role: "ASSISTANT", channel: "FEISHU", inReplyToChannelMessageId: firstInboundId, text: "第一条回复" });

    await expect(repository.findAssistantReplyByInboundMessageId(firstInboundId)).resolves.toMatchObject({ text: "第一条回复" });
  });

  it("keeps one active Intake per employee and allows a new one after abandonment", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id });

    await expect(repository.createIntake({ employeeId: employee.id, conversationId: conversation.id })).rejects.toThrow("active intake exists");
    await repository.updateIntake({ id: intake.id, status: "ABANDONED" });
    await expect(repository.createIntake({ employeeId: employee.id, conversationId: conversation.id })).resolves.toMatchObject({
      status: "COLLECTING",
    });
  });

  it("persists a restart request and atomically creates a replacement Intake", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const original = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id, submissionToken: "old-token" });
    const requestedAt = new Date("2026-10-25T01:00:00.000Z");

    await repository.updateIntake({ id: original.id, restartRequestedAt: requestedAt });
    await expect(prisma.reimbursementIntake.findUniqueOrThrow({ where: { id: original.id } })).resolves.toMatchObject({ restartRequestedAt: requestedAt });

    const replacement = await repository.restartIntake({ employeeId: employee.id, conversationId: conversation.id, intakeId: original.id, requestedAfter: new Date("2026-10-25T00:50:00.000Z") });
    expect(replacement).toMatchObject({ employeeId: employee.id, conversationId: conversation.id, status: "COLLECTING", pendingFields: ["purpose"] });
    expect(replacement.id).not.toBe(original.id);
    await expect(prisma.reimbursementIntake.findUniqueOrThrow({ where: { id: original.id } })).resolves.toMatchObject({ status: "ABANDONED", submissionToken: null, restartRequestedAt: null });
    await expect(repository.getCurrentIntake(employee.id)).resolves.toMatchObject({ id: replacement.id });
  });

  it("rejects stale or foreign restart requests without abandoning the active Intake", async () => {
    const employee = await createEmployee();
    const ownConversation = await repository.getOrCreatePrivate(employee.id);
    const otherConversation = await repository.getOrCreateGroup(employee.id, "oc-other");
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: ownConversation.id });
    await repository.updateIntake({ id: intake.id, restartRequestedAt: new Date("2026-10-25T00:00:00.000Z") });

    await expect(repository.restartIntake({ employeeId: employee.id, conversationId: ownConversation.id, intakeId: intake.id, requestedAfter: new Date("2026-10-25T00:50:00.000Z") })).rejects.toThrow("restart request unavailable");
    await expect(repository.restartIntake({ employeeId: employee.id, conversationId: otherConversation.id, intakeId: intake.id, requestedAfter: new Date("2026-10-24T23:50:00.000Z") })).rejects.toThrow("restart request unavailable");
    await expect(repository.getCurrentIntake(employee.id)).resolves.toMatchObject({ id: intake.id, status: "COLLECTING" });
  });

  it("consumes a restart request once even when submitted concurrently", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id });
    await repository.updateIntake({ id: intake.id, restartRequestedAt: new Date("2026-10-25T01:00:00.000Z") });
    const input = { employeeId: employee.id, conversationId: conversation.id, intakeId: intake.id, requestedAfter: new Date("2026-10-25T00:50:00.000Z") };

    const attempts = await Promise.allSettled([repository.restartIntake(input), repository.restartIntake(input)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    await expect(prisma.reimbursementIntake.count({ where: { employeeId: employee.id, status: "COLLECTING" } })).resolves.toBe(1);
  });

  it("rolls back abandonment if creating the replacement fails", async () => {
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    const intake = await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id });
    const requestedAt = new Date("2026-10-25T01:00:00.000Z");
    await repository.updateIntake({ id: intake.id, restartRequestedAt: requestedAt });
    const faultingPrisma = prisma.$extends({ query: { reimbursementIntake: { create: async () => { throw new Error("replacement create failed"); } } } });
    const faultingRepository = new AgentConversationRepository(faultingPrisma as unknown as PrismaClient);

    await expect(faultingRepository.restartIntake({ employeeId: employee.id, conversationId: conversation.id, intakeId: intake.id, requestedAfter: new Date("2026-10-25T00:50:00.000Z") })).rejects.toThrow("replacement create failed");
    await expect(prisma.reimbursementIntake.findUniqueOrThrow({ where: { id: intake.id } })).resolves.toMatchObject({ status: "COLLECTING", restartRequestedAt: requestedAt });
  });

  it("cascades conversations, messages, and Intakes when the employee is deleted", async () => {
    const before = {
      conversations: await prisma.agentConversation.count(),
      messages: await prisma.agentMessage.count(),
      intakes: await prisma.reimbursementIntake.count(),
    };
    const employee = await createEmployee();
    const conversation = await repository.getOrCreatePrivate(employee.id);
    await repository.appendMessage({ conversationId: conversation.id, role: "USER", channel: "WEB", text: "报销上限是多少？" });
    await repository.createIntake({ employeeId: employee.id, conversationId: conversation.id });

    await prisma.employee.delete({ where: { id: employee.id } });

    await expect(prisma.agentConversation.count()).resolves.toBe(before.conversations);
    await expect(prisma.agentMessage.count()).resolves.toBe(before.messages);
    await expect(prisma.reimbursementIntake.count()).resolves.toBe(before.intakes);
  });
});
