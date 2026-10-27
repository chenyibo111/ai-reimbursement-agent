import { expect, it, vi } from "vitest";

import { AGENT_PROGRESS_EVENT_CONSUMER, AGENT_RECEIPT_EVENT_CONSUMER, RECEIPT_EXTRACTION_COMPLETED_SUBJECT, ensureProgressConsumer, ensureReceiptExtractionConsumer } from "./jetstream-durable-consumer";

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

it("creates a separate progress durable without touching the OCR cursor", async () => {
  const info = vi.fn().mockRejectedValue(new Error("consumer not found"));
  const add = vi.fn();
  await ensureProgressConsumer({ consumers: { info, add } });
  expect(add).toHaveBeenCalledWith("REIMBURSEMENT", expect.objectContaining({ durable_name: AGENT_PROGRESS_EVENT_CONSUMER, filter_subject: "reimbursement.>", ack_policy: "explicit" }));
  expect(add.mock.calls[0][1].durable_name).not.toBe(AGENT_RECEIPT_EVENT_CONSUMER);
});

it("does not reset the durable cursor when the consumer already exists", async () => {
  const info = vi.fn().mockResolvedValue({});
  const add = vi.fn();

  await ensureReceiptExtractionConsumer({ consumers: { info, add } });

  expect(add).not.toHaveBeenCalled();
});
