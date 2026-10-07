import { expect, it } from "vitest";

import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";

function attachmentDeps(overrides: Partial<ProcessFeishuEventDeps> = {}) {
  const calls = { download: 0, turns: 0 };
  const deps: ProcessFeishuEventDeps = {
    botOpenId: "ou-bot",
    publicAppUrl: "https://reimbursement.example.test",
    events: {
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "image", chatId: "oc-1", senderOpenId: "ou-employee", chatType: "p2p", mentionedOpenIds: [] }),
      findEmployeeByOpenId: async () => ({ id: "employee-1" }),
    },
    conversations: {
      getOrCreatePrivate: async () => ({ id: "private-1" }),
      getOrCreateGroup: async () => ({ id: "group-1" }),
      recordFeishuDeliveryTarget: async () => undefined,
    },
    client: {
      getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "image", text: "", mentions: [], attachments: [{ fileKey: "img-1", resourceType: "image", filename: "receipt.jpg" }] }),
      downloadResource: async () => {
        calls.download += 1;
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), filename: "receipt.jpg", mimeType: "image/jpeg" };
      },
      sendText: async () => undefined,
      replyText: async () => undefined,
      replyCard: async () => undefined,
    },
    runConversationTurn: async (input) => {
      calls.turns += 1;
      expect(input).toMatchObject({ actorId: "employee-1", conversationId: "private-1", channel: "FEISHU", chatId: "oc-1", channelMessageId: "om-1", message: "上传票据", attachment: { filename: "receipt.jpg", mimeType: "image/jpeg" } });
      return { reply: "票据已上传并进入识别流程。", citations: [], intake: { id: "intake-1", employeeId: "employee-1", conversationId: "private-1", status: "COLLECTING", claimId: "claim-1", collectedFields: {}, pendingFields: ["purpose"], submissionToken: null } };
    },
    ...overrides,
  };
  return { deps, calls };
}

it("downloads an attachment and delegates storage, extraction, and intake handling to one conversation turn", async () => {
  const { deps, calls } = attachmentDeps();

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "AGENT_REPLIED", claimId: "claim-1", replyText: expect.stringContaining("/claims/claim-1") });
  expect(calls).toEqual({ download: 1, turns: 1 });
});

it("does not download an attachment for an employee that has not completed Web OAuth binding", async () => {
  const { deps, calls } = attachmentDeps({ events: { ...attachmentDeps().deps.events, findEmployeeByOpenId: async () => null } });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "LOGIN_REQUIRED" });
  expect(calls.download).toBe(0);
  expect(calls.turns).toBe(0);
});

it("keeps downloaded attachment validation in the shared upload pipeline", async () => {
  const { deps, calls } = attachmentDeps({
    runConversationTurn: async () => { throw new Error("file signature does not match declared type"); },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "RETRYABLE_FAILURE", retryable: false });
  expect(calls.download).toBe(1);
});
