import { expect, it, vi } from "vitest";

import { deliverReceiptExtractionNotificationOnce } from "@/src/application/deliver-receipt-extraction-notifications";

const notification = {
  id: "notification-1",
  jobId: "job-1",
  receiptId: "receipt-1",
  claimId: "claim-1",
  conversationId: "conversation-1",
  chatId: "oc-1",
  status: "PROCESSING" as const,
  attemptCount: 1,
  maxAttempts: 3,
  job: {
    status: "REVIEW_REQUIRED" as const,
    failureCode: "OCR_LOW_CONFIDENCE",
    receipt: { extractionPayload: { invoiceNumber: { value: "INV-1", confidence: 0.98, source: "EXTRACTED" }, issuedOn: { value: null, confidence: 0, source: "EXTRACTED" }, totalAmountCents: { value: null, confidence: 0, source: "EXTRACTED" } } },
  },
};

function createDeps(overrides: { claimed?: typeof notification | null; send?: () => Promise<void> } = {}) {
  const recoverExpiredLeases = vi.fn(async () => 0);
  const claimNextDeliverable = vi.fn(async () => overrides.claimed === undefined ? notification : overrides.claimed);
  const markSent = vi.fn(async () => undefined);
  const markRetryWait = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const sendText = vi.fn(async () => overrides.send?.());
  const appendMessage = vi.fn(async () => undefined);
  return {
    deps: {
      notifications: { recoverExpiredLeases, claimNextDeliverable, markSent, markRetryWait, close },
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
