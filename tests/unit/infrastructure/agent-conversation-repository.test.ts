import { expect, it, vi } from "vitest";

import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";

it("stores a Go reimbursement claim ID as an opaque scalar reference", async () => {
  const update = vi.fn().mockResolvedValue({ id: "intake-1", claimId: "go-claim-1" });
  const repository = new AgentConversationRepository({
    reimbursementIntake: { update },
  } as never);

  await repository.updateIntake({ id: "intake-1", claimId: "go-claim-1" });

  expect(update).toHaveBeenCalledWith({
    where: { id: "intake-1" },
    data: expect.objectContaining({ claimId: "go-claim-1" }),
  });
  expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("claim");
});

it("records the verified Feishu chat ID as an agent-owned delivery target", async () => {
  const update = vi.fn().mockResolvedValue({ id: "conversation-1" });
  const repository = new AgentConversationRepository({
    agentConversation: { update },
  } as never);

  await repository.recordFeishuDeliveryTarget({ conversationId: "conversation-1", chatId: "oc-1" });

  expect(update).toHaveBeenCalledWith({
    where: { id: "conversation-1" },
    data: { latestFeishuChatId: "oc-1" },
  });
});

it("resolves an OCR notification target from agent-owned conversation state", async () => {
  const findFirst = vi.fn().mockResolvedValue({
    employeeId: "employee-1",
    conversationId: "conversation-1",
    conversation: { latestFeishuChatId: "oc-1" },
  });
  const repository = new AgentConversationRepository({
    reimbursementIntake: { findFirst },
  } as never);

  await expect(repository.findNotificationTargetByClaimId("go-claim-1")).resolves.toEqual({
    employeeId: "employee-1",
    conversationId: "conversation-1",
    chatId: "oc-1",
  });
  expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ claimId: "go-claim-1" }),
  }));
});
