import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const repository = new AgentConversationRepository(prisma);
const employeeIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  for (const employeeId of employeeIds.splice(0)) {
    await prisma.claimDraft.deleteMany({ where: { employeeId } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function asConversationStore(): ConversationStore {
  return repository as unknown as ConversationStore;
}

async function createEmployee() {
  const id = `conversation-flow-${Date.now()}-${employeeIds.length + 1}`;
  employeeIds.push(id);
  return prisma.employee.create({ data: { id, displayName: "会话流程员工" } });
}

it("keeps policy-only turns out of Intake and creates one persisted agent claim for attachments", async () => {
  const employee = await createEmployee();
  const conversation = await repository.getOrCreatePrivate(employee.id);
  const createClaim = vi.fn(async (_input: { actorId: string }) => prisma.claimDraft.create({ data: { employeeId: employee.id } }));
  const uploadReceipt = vi.fn(async () => ({ id: "receipt-1" }));
  const deps = {
    conversations: asConversationStore(),
    model: {
      classifyIntent: async () => "POLICY_QUERY" as const,
      answerPolicy: async () => "住宿上限请以制度片段为准。",
      decideConversation: async () => ({ action: "ANSWER" as const, reply: "好的" }),
    },
    searchPolicy: async () => [{ id: "citation-1", title: "差旅制度", url: "https://example.test/doc", headingPath: ["住宿"], excerpt: "住宿上限", score: 0.9 }],
    createClaim: async ({ actorId }: { actorId: string }) => createClaim({ actorId }),
    preflightAttachment: async () => undefined,
    uploadReceipt,
  };

  await expect(runConversationTurn({ actorId: employee.id, conversationId: conversation.id, channel: "WEB", message: "住宿上限是多少" }, deps)).resolves.toMatchObject({ intake: null });
  await expect(repository.getCurrentIntake(employee.id)).resolves.toBeNull();

  await runConversationTurn({
    actorId: employee.id,
    conversationId: conversation.id,
    channel: "WEB",
    message: "上传发票",
    attachment: { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
  }, deps);

  const intake = await repository.getCurrentIntake(employee.id);
  expect(createClaim).toHaveBeenCalledTimes(1);
  expect(uploadReceipt).toHaveBeenCalledWith(expect.objectContaining({ actorId: employee.id, claimId: intake?.claimId }));
  expect(intake).toMatchObject({ conversationId: conversation.id, status: "COLLECTING" });
  await expect(repository.listMessages({ conversationId: conversation.id })).resolves.toHaveLength(4);
});
