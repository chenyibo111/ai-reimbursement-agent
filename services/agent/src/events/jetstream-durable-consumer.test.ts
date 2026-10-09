import { expect, it, vi } from "vitest";

import { AGENT_RECEIPT_EVENT_CONSUMER, RECEIPT_EXTRACTION_COMPLETED_SUBJECT, ensureReceiptExtractionConsumer } from "./jetstream-durable-consumer";

it("creates a durable explicit-ack consumer for OCR completion events", async () => {
  const info = vi.fn().mockRejectedValue(new Error("consumer not found"));
  const add = vi.fn().mockResolvedValue({});

  await ensureReceiptExtractionConsumer({ consumers: { info, add } });

  expect(add).toHaveBeenCalledWith("REIMBURSEMENT", expect.objectContaining({
    durable_name: AGENT_RECEIPT_EVENT_CONSUMER,
    filter_subject: RECEIPT_EXTRACTION_COMPLETED_SUBJECT,
    ack_policy: "explicit",
    max_deliver: 10,
  }));
});

it("does not reset the durable cursor when the consumer already exists", async () => {
  const info = vi.fn().mockResolvedValue({});
  const add = vi.fn();

  await ensureReceiptExtractionConsumer({ consumers: { info, add } });

  expect(add).not.toHaveBeenCalled();
});
