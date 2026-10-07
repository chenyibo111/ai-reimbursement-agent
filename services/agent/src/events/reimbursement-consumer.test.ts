import { describe, expect, it, vi } from "vitest";

import { createReimbursementEventConsumer } from "./reimbursement-consumer";

describe("reimbursement event consumer", () => {
  it("uses receipt.extraction.completed only to notify and refetches the workbench", async () => {
    const port = { getClaimWorkbench: vi.fn().mockResolvedValue({ claim: { id: "claim-1", version: 2, status: "DRAFT", purpose: "客户拜访" }, receipts: [] }) };
    const notify = vi.fn();
    const consumer = createReimbursementEventConsumer({ port: port as never, wasProcessed: vi.fn().mockResolvedValue(false), markProcessed: vi.fn(), notify });

    await consumer.handle({ event_id: "event-1", event_type: "ReceiptExtractionCompleted", aggregate_id: "receipt-1", payload: { claimId: "claim-1", employeeId: "employee-1", conversationId: "conversation-1" } });

    expect(port.getClaimWorkbench).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ claimId: "claim-1", conversationId: "conversation-1" }));
  });
});
