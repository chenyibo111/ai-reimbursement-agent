import { expect, it, vi } from "vitest";

import { consumeReceiptExtractionEvents } from "./jetstream-consumer";

it("acks only after the receipt event handler succeeds", async () => {
  const ack = vi.fn();
  const consumer = { next: vi.fn().mockResolvedValue({ data: new TextEncoder().encode(JSON.stringify({ event_id: "event-1", event_type: "ReceiptExtractionCompleted", aggregate_id: "receipt-1", payload: { claimId: "claim-1" } })), ack, nak: vi.fn() }) };
  const handled = vi.fn();

  await consumeReceiptExtractionEvents({ consumer, handle: handled, shouldContinue: () => consumer.next.mock.calls.length === 0 });

  expect(handled).toHaveBeenCalledWith(expect.objectContaining({ event_id: "event-1" }));
  expect(ack).toHaveBeenCalledOnce();
});

it("naks an event when notification handling fails", async () => {
  const ack = vi.fn();
  const nak = vi.fn();
  const consumer = { next: vi.fn().mockResolvedValue({ data: new TextEncoder().encode(JSON.stringify({ event_id: "event-2", event_type: "ReceiptExtractionCompleted", aggregate_id: "receipt-2", payload: { claimId: "claim-2" } })), ack, nak }) };

  await consumeReceiptExtractionEvents({ consumer, handle: async () => { throw new Error("Feishu unavailable"); }, shouldContinue: () => consumer.next.mock.calls.length === 0 });

  expect(ack).not.toHaveBeenCalled();
  expect(nak).toHaveBeenCalledWith(5_000);
});
