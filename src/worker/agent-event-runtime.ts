import type { ReimbursementPort } from "../../services/agent/src/ports/reimbursement-port";
import { createReimbursementEventConsumer } from "../../services/agent/src/events/reimbursement-consumer";
import { formatReceiptExtractionEventNotification } from "../../services/agent/src/events/receipt-notification";
import { formatClaimProgress } from "@/src/application/claim-progress";

/** Connects an Agent-owned event ledger and channel target to the tool-only reimbursement boundary. */
export function createAgentEventNotificationHandler(deps: {
  port: ReimbursementPort;
  processedEvents: { wasProcessed(eventId: string): Promise<boolean>; markProcessed(eventId: string): Promise<void> };
  conversations: {
    findNotificationTargetByClaimId(claimId: string): Promise<{ employeeId: string; conversationId: string; chatId: string } | null>;
    appendMessage(input: { conversationId: string; role: "ASSISTANT"; channel: "FEISHU"; channelMessageId: string; text: string; result: Record<string, string> }): Promise<unknown>;
  };
  client: { sendText(chatId: string, text: string, uuid: string): Promise<void> };
  publicAppUrl: string;
  acceptedEventTypes?: readonly string[];
}) {
  return createReimbursementEventConsumer({
    port: deps.port,
    acceptedEventTypes: deps.acceptedEventTypes,
    wasProcessed: (eventId) => deps.processedEvents.wasProcessed(eventId),
    markProcessed: (eventId) => deps.processedEvents.markProcessed(eventId),
    findNotificationTarget: (claimId) => deps.conversations.findNotificationTargetByClaimId(claimId),
    notify: async ({ eventId, eventType, claimId, receiptId, conversationId, chatId, workbench, progress }) => {
      const text = progress ? `${eventType === "ClaimSubmitted" ? "报销单已提交。" : eventType === "ReceiptReviewRequired" ? "票据需要人工复核。" : "票据复核已处理。"}\n${formatClaimProgress(progress)}\n报销工作台：${deps.publicAppUrl.replace(/\/$/, "")}/claims/${encodeURIComponent(claimId)}` : formatReceiptExtractionEventNotification({
        publicAppUrl: deps.publicAppUrl,
        claimId,
        receiptId,
        workbench: workbench as { receipts: Array<{ id: string; filename: string; status: string; invoiceNumber: string; ocrConfidence: number }> },
      });
      await deps.client.sendText(chatId, text, eventId);
      await deps.conversations.appendMessage({
        conversationId,
        role: "ASSISTANT",
        channel: "FEISHU",
        channelMessageId: eventId,
        text,
        result: { eventId, claimId },
      });
    },
  });
}
