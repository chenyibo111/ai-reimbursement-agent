import { describe, expect, it, vi } from "vitest";

import { createReimbursementEventConsumer } from "./reimbursement-consumer";

describe("reimbursement event consumer", () => {
  it("uses receipt.extraction.completed only to notify and refetches the workbench through agent-owned routing", async () => {
    const port = { getClaimWorkbench: vi.fn().mockResolvedValue({ claim: { id: "claim-1", version: 2, status: "DRAFT", purpose: "客户拜访" }, receipts: [] }) };
    const notify = vi.fn();
    const findNotificationTarget = vi.fn().mockResolvedValue({ employeeId: "employee-1", conversationId: "conversation-1", chatId: "oc-1" });
    const consumer = createReimbursementEventConsumer({ port: port as never, wasProcessed: vi.fn().mockResolvedValue(false), markProcessed: vi.fn(), findNotificationTarget, notify });

    await consumer.handle({ event_id: "event-1", event_type: "ReceiptExtractionCompleted", aggregate_id: "receipt-1", payload: { claimId: "claim-1" } });

    expect(findNotificationTarget).toHaveBeenCalledWith("claim-1");
    expect(port.getClaimWorkbench).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ eventId: "event-1", claimId: "claim-1", conversationId: "conversation-1", chatId: "oc-1" }));
  });

  it("refetches employee progress for review and submission events and deduplicates replay", async () => {
    const progress = { claimId: "claim-1", claimNumber: "BX-1", status: "SUBMITTED" };
    const port = { getClaimWorkbench: vi.fn(), getOwnedClaimProgress: vi.fn().mockResolvedValue(progress) };
    const seen = new Set<string>();
    const notify = vi.fn();
    const consumer = createReimbursementEventConsumer({ port: port as never,
      wasProcessed: async (id) => seen.has(id), markProcessed: async (id) => { seen.add(id); },
      findNotificationTarget: vi.fn().mockResolvedValue({ employeeId: "employee-1", conversationId: "conversation-1", chatId: "oc-private" }), notify });
    const event = { event_id: "event-progress", event_type: "ReceiptReviewResolved", aggregate_id: "receipt-1", payload: { claimId: "claim-1" } };
    await consumer.handle(event);
    await consumer.handle(event);
    expect(port.getOwnedClaimProgress).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ eventType: "ReceiptReviewResolved", progress }));
  });

  it("does not notify when there is no trusted target or the fresh Go read fails", async () => {
    const port = { getClaimWorkbench: vi.fn(), getOwnedClaimProgress: vi.fn().mockRejectedValue(new Error("Go unavailable")) };
    const notify = vi.fn();
    const markProcessed = vi.fn();
    const findNotificationTarget = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ employeeId: "employee-1", conversationId: "conversation-1", chatId: "oc-private" });
    const consumer = createReimbursementEventConsumer({ port: port as never, wasProcessed: vi.fn().mockResolvedValue(false), markProcessed, findNotificationTarget, notify });
    const event = { event_id: "event-submitted", event_type: "ClaimSubmitted", aggregate_id: "claim-1", payload: { claimId: "claim-1" } };
    await consumer.handle(event);
    await expect(consumer.handle(event)).rejects.toThrow("Go unavailable");
    expect(notify).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });
});
