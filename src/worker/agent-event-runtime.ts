import type { ReimbursementPort } from "../../services/agent/src/ports/reimbursement-port";
import { createReimbursementEventConsumer } from "../../services/agent/src/events/reimbursement-consumer";
import { formatReceiptExtractionEventNotification } from "../../services/agent/src/events/receipt-notification";
import { formatClaimProgress } from "@/src/application/claim-progress";
import { publicWorkspaceUrl } from "../../services/agent/src/events/public-workspace-url";
import { renderConfiguredNotification, selectNotificationTemplate, type NotificationConfigSnapshot } from "@/src/application/render-configured-notification";

type NotificationSnapshot = { eventId: string; version: number; enabled: boolean; text: string | null };

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
  notificationConfigs?: { getActive(): Promise<NotificationConfigSnapshot | null>; getVersion?(version: number): Promise<NotificationConfigSnapshot> };
  notificationSnapshots?: { find(eventId: string): Promise<NotificationSnapshot | null>; getOrCreate(candidate: NotificationSnapshot): Promise<NotificationSnapshot> };
}) {
  return createReimbursementEventConsumer({
    port: deps.port,
    acceptedEventTypes: deps.acceptedEventTypes,
    wasProcessed: (eventId) => deps.processedEvents.wasProcessed(eventId),
    markProcessed: (eventId) => deps.processedEvents.markProcessed(eventId),
    findNotificationTarget: (claimId) => deps.conversations.findNotificationTargetByClaimId(claimId),
    notify: async ({ eventId, eventType, claimId, receiptId, conversationId, chatId, notificationConfigVersion, workbench, progress }) => {
      const workspace = publicWorkspaceUrl(deps.publicAppUrl, claimId);
      const text = progress ? `${eventType === "ClaimSubmitted" ? "报销单已提交。" : eventType === "ReceiptReviewRequired" ? "票据需要人工复核。" : "票据复核已处理。"}\n${formatClaimProgress(progress)}${workspace ? `\n报销工作台：${workspace}` : ""}` : formatReceiptExtractionEventNotification({
        publicAppUrl: deps.publicAppUrl,
        claimId,
        receiptId,
        workbench: workbench as { receipts: Array<{ id: string; filename: string; status: string; invoiceNumber: string; ocrConfidence: number }> },
      });
      let delivery: NotificationSnapshot | null = null;
      if (deps.notificationConfigs && deps.notificationSnapshots) {
        delivery = await deps.notificationSnapshots.find(eventId);
        if (!delivery) {
          if (notificationConfigVersion && !deps.notificationConfigs.getVersion) throw new Error("notification config version reader unavailable");
          const config = notificationConfigVersion ? await deps.notificationConfigs.getVersion!(notificationConfigVersion) : null;
          const selected = selectNotificationTemplate(config, eventType);
          delivery = await deps.notificationSnapshots.getOrCreate({ eventId, version: selected.version, enabled: selected.enabled, text: selected.enabled ? renderConfiguredNotification(selected.template, { body: text }) : null });
        }
        if (!delivery.enabled) return;
      }
      const message = delivery?.text ?? text;
      await deps.client.sendText(chatId, message, eventId);
      await deps.conversations.appendMessage({
        conversationId,
        role: "ASSISTANT",
        channel: "FEISHU",
        channelMessageId: eventId,
        text: message,
        result: { eventId, claimId },
      });
    },
  });
}
