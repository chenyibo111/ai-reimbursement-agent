import { formatReceiptExtractionNotification } from "@/src/application/format-receipt-extraction-notification";
import { FeishuBotClientError } from "@/src/infrastructure/feishu/feishu-bot-client";
import type { ClaimedReceiptExtractionNotification } from "@/src/infrastructure/prisma/receipt-extraction-notification-repository";

export async function deliverReceiptExtractionNotificationOnce(deps: {
  notifications: {
    recoverExpiredLeases(now: Date): Promise<number>;
    claimNextDeliverable(now: Date, leaseMs: number): Promise<ClaimedReceiptExtractionNotification | null>;
    markSent(id: string, now: Date): Promise<void>;
    markRetryWait(id: string, failureCode: string, now: Date): Promise<void>;
    close(id: string, failureCode: string): Promise<void>;
  };
  client: { sendText(chatId: string, text: string, uuid: string): Promise<void> };
  conversations: { appendMessage(input: { conversationId: string; role: "ASSISTANT"; channel: "FEISHU"; channelMessageId: string; text: string; result: Record<string, string | null> }): Promise<unknown> };
  publicAppUrl: string;
  now(): Date;
  leaseMs: number;
}): Promise<boolean> {
  const now = deps.now();
  await deps.notifications.recoverExpiredLeases(now);
  const notification = await deps.notifications.claimNextDeliverable(now, deps.leaseMs);
  if (!notification) return false;

  const text = formatReceiptExtractionNotification({
    publicAppUrl: deps.publicAppUrl,
    claimId: notification.claimId,
    jobStatus: notification.job.status,
    extractionPayload: notification.job.receipt?.extractionPayload ?? null,
  });
  try {
    await deps.client.sendText(notification.chatId, text, notification.id);
    await deps.conversations.appendMessage({
      conversationId: notification.conversationId,
      role: "ASSISTANT",
      channel: "FEISHU",
      channelMessageId: notification.id,
      text,
      result: { jobId: notification.jobId, receiptId: notification.receiptId, notificationId: notification.id },
    });
    await deps.notifications.markSent(notification.id, now);
  } catch (error) {
    if (error instanceof FeishuBotClientError && ["UNAUTHORIZED", "RESOURCE_NOT_FOUND", "REJECTED"].includes(error.code)) {
      await deps.notifications.close(notification.id, `FEISHU_DELIVERY_${error.code}`);
    } else {
      await deps.notifications.markRetryWait(notification.id, "FEISHU_DELIVERY_UNAVAILABLE", now);
    }
  }
  return true;
}
