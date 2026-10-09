import { expect, it, vi } from "vitest";

import { createAgentEventNotificationHandler } from "@/src/worker/agent-event-runtime";

it("delivers a refetched OCR result once and records it in the Agent conversation", async () => {
  const port = {
    getClaimWorkbench: vi.fn().mockResolvedValue({
      claim: { id: "claim-1", version: 1, status: "DRAFT", purpose: "客户拜访" },
      receipts: [{ id: "receipt-1", claimId: "claim-1", filename: "hotel.pdf", status: "EXTRACTED", invoiceNumber: "INV-001", ocrConfidence: 0.98 }],
    }),
  };
  const markProcessed = vi.fn();
  const sendText = vi.fn();
  const appendMessage = vi.fn();
  const handler = createAgentEventNotificationHandler({
    port: port as never,
    processedEvents: { wasProcessed: async () => false, markProcessed },
    conversations: {
      findNotificationTargetByClaimId: async () => ({ employeeId: "employee-1", conversationId: "conversation-1", chatId: "oc-1" }),
      appendMessage,
    },
    client: { sendText },
    publicAppUrl: "https://reimbursement.example.test",
  });

  await handler.handle({ event_id: "event-1", event_type: "ReceiptExtractionCompleted", aggregate_id: "receipt-1", payload: { claimId: "claim-1" } });

  expect(sendText).toHaveBeenCalledWith("oc-1", expect.stringContaining("发票号码：INV-001"), "event-1");
  expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
    conversationId: "conversation-1",
    channel: "FEISHU",
    channelMessageId: "event-1",
  }));
  expect(markProcessed).toHaveBeenCalledWith("event-1");
});
