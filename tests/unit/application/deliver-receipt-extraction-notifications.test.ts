import { expect, it, vi } from "vitest";

import { deliverReceiptExtractionNotificationOnce } from "@/src/application/deliver-receipt-extraction-notifications";
import { FeishuBotClientError } from "@/src/infrastructure/feishu/feishu-bot-client";
import type { ClaimedReceiptExtractionNotification } from "@/src/infrastructure/prisma/receipt-extraction-notification-repository";

const notification: ClaimedReceiptExtractionNotification = {
  id: "notification-1",
  jobId: "job-1",
  receiptId: "receipt-1",
  claimId: "claim-1",
  conversationId: "conversation-1",
  chatId: "oc-1",
  status: "PROCESSING",
  attemptCount: 1,
  maxAttempts: 3,
  templateVersion: null,
  templateEnabled: null,
  templateText: null,
  renderedText: null,
  job: {
    status: "REVIEW_REQUIRED",
    failureCode: "OCR_LOW_CONFIDENCE",
    receipt: { extractionPayload: { invoiceNumber: { value: "INV-1", confidence: 0.98, source: "EXTRACTED" }, issuedOn: { value: null, confidence: 0, source: "EXTRACTED" }, totalAmountCents: { value: null, confidence: 0, source: "EXTRACTED" } } },
  },
};

function createDeps(overrides: { claimed?: ClaimedReceiptExtractionNotification | null; send?: () => Promise<void> } = {}) {
  const recoverExpiredLeases = vi.fn(async () => 0);
  const claimNextDeliverable = vi.fn(async () => overrides.claimed === undefined ? notification : overrides.claimed);
  const markSent = vi.fn(async () => undefined);
  const markRetryWait = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const saveRenderedTextIfAbsent = vi.fn(async (_id: string, text: string) => text);
  const sendText = vi.fn(async () => overrides.send?.());
  const appendMessage = vi.fn(async () => undefined);
  return {
    deps: {
      notifications: { recoverExpiredLeases, claimNextDeliverable, markSent, markRetryWait, close, saveRenderedTextIfAbsent },
      client: { sendText },
      conversations: { appendMessage },
      publicAppUrl: "https://reimbursement.example.test",
      now: () => new Date("2099-09-28T10:00:00.000Z"),
      leaseMs: 60_000,
    },
    recoverExpiredLeases,
    claimNextDeliverable,
    markSent,
    markRetryWait,
    close,
    sendText,
    appendMessage,
  };
}

it("sends one OCR result notification with a durable Feishu idempotency key and conversation history", async () => {
  const { deps, sendText, appendMessage, markSent } = createDeps();

  await expect(deliverReceiptExtractionNotificationOnce(deps)).resolves.toBe(true);

  expect(sendText).toHaveBeenCalledWith("oc-1", expect.stringContaining("已转人工复核"), "notification-1");
  expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
    conversationId: "conversation-1",
    role: "ASSISTANT",
    channel: "FEISHU",
    channelMessageId: "notification-1",
    result: { jobId: "job-1", receiptId: "receipt-1", notificationId: "notification-1" },
  }));
  expect(markSent).toHaveBeenCalledWith("notification-1", new Date("2099-09-28T10:00:00.000Z"));
});

it("returns without sending when no terminal OCR notification is available and retries transient delivery failures", async () => {
  const empty = createDeps({ claimed: null });
  await expect(deliverReceiptExtractionNotificationOnce(empty.deps)).resolves.toBe(false);
  expect(empty.sendText).not.toHaveBeenCalled();

  const unavailable = createDeps({ send: async () => { throw new Error("network unavailable"); } });
  await expect(deliverReceiptExtractionNotificationOnce(unavailable.deps)).resolves.toBe(true);
  expect(unavailable.markRetryWait).toHaveBeenCalledWith("notification-1", "FEISHU_DELIVERY_UNAVAILABLE", new Date("2099-09-28T10:00:00.000Z"));
});

it("closes a notification when Feishu rejects an otherwise successful HTTP request", async () => {
  const rejected = createDeps({ send: async () => { throw new FeishuBotClientError("REJECTED", "230001"); } });

  await expect(deliverReceiptExtractionNotificationOnce(rejected.deps)).resolves.toBe(true);

  expect(rejected.close).toHaveBeenCalledWith("notification-1", "FEISHU_DELIVERY_REJECTED");
  expect(rejected.markRetryWait).not.toHaveBeenCalled();
});

it("sends the persisted configured text after a retry", async () => {
  const configured = { ...notification, templateVersion: 7, templateEnabled: true, templateText: "通知：{{body}}", renderedText: "通知：首次生成的文案" };
  const { deps, sendText } = createDeps({ claimed: configured });
  await deliverReceiptExtractionNotificationOnce(deps);
  expect(sendText).toHaveBeenCalledWith("oc-1", "通知：首次生成的文案", "notification-1");
});
