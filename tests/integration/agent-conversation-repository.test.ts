import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

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
