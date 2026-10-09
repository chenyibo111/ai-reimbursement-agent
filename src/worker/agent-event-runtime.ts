import type { ReimbursementPort } from "../../services/agent/src/ports/reimbursement-port";
import { createReimbursementEventConsumer } from "../../services/agent/src/events/reimbursement-consumer";
import { formatReceiptExtractionEventNotification } from "../../services/agent/src/events/receipt-notification";

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
}) {
  return createReimbursementEventConsumer({
    port: deps.port,
    wasProcessed: (eventId) => deps.processedEvents.wasProcessed(eventId),
    markProcessed: (eventId) => deps.processedEvents.markProcessed(eventId),
    findNotificationTarget: (claimId) => deps.conversations.findNotificationTargetByClaimId(claimId),
    notify: async ({ eventId, claimId, conversationId, chatId, workbench }) => {
      const text = formatReceiptExtractionEventNotification({
        publicAppUrl: deps.publicAppUrl,
        claimId,
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
