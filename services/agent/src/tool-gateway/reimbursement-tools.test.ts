import { describe, expect, it, vi } from "vitest";

import { ReimbursementToolGateway, type ToolCallResultStore } from "./reimbursement-tools";

describe("ReimbursementToolGateway", () => {
  it("deletes only a stable receipt ID at the confirmed claim version", async () => {
    const port = { deleteOwnedReceipt: vi.fn().mockResolvedValue(undefined) };
    const store: ToolCallResultStore = { findCompleted: vi.fn().mockResolvedValue(null), saveCompleted: vi.fn() };
    const gateway = new ReimbursementToolGateway(port as never, store);
    const call = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: "conversation-1", toolCallId: "delete-1", idempotencyKey: "delete-1", name: "delete_owned_receipt" as const,
      arguments: { claimId: "claim-1", receiptId: "receipt-2", expectedClaimVersion: 3 } };
    await gateway.execute(call);
    expect(port.deleteOwnedReceipt).toHaveBeenCalledWith(expect.objectContaining({ actorEmployeeId: "employee-1", claimId: "claim-1", receiptId: "receipt-2", expectedClaimVersion: 3 }));
    await expect(gateway.execute({ ...call, arguments: { ...call.arguments, expectedClaimVersion: 0 } })).rejects.toThrow("invalid expectedClaimVersion");
    expect(port.deleteOwnedReceipt).toHaveBeenCalledTimes(1);
  });
  it("rejects owner overrides, unknown fields, and invalid search limits", async () => {
    const port = { searchOwnedClaims: vi.fn() };
    const store: ToolCallResultStore = { findCompleted: vi.fn().mockResolvedValue(null), saveCompleted: vi.fn() };
    const gateway = new ReimbursementToolGateway(port as never, store);
    const base = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "WEB" as const, conversationId: "conversation-1", toolCallId: "search", idempotencyKey: "search", name: "search_owned_claims" as const };
    for (const args of [{ limit: 101 }, { limit: 0 }, { limit: 5, ownerId: "employee-2" }, { limit: 5, unknown: "x" }]) {
      await expect(gateway.execute({ ...base, arguments: args })).rejects.toThrow();
    }
    expect(port.searchOwnedClaims).not.toHaveBeenCalled();
  });
  it("replays a completed owned search without asking Go again", async () => {
    const page = { items: [], totalCount: 0, nextCursor: null };
    const port = { searchOwnedClaims: vi.fn().mockResolvedValue(page) };
    const store: ToolCallResultStore = { findCompleted: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ page }), saveCompleted: vi.fn() };
    const gateway = new ReimbursementToolGateway(port as never, store);
    const call = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "WEB" as const, conversationId: "conversation-1", toolCallId: "search", idempotencyKey: "search", name: "search_owned_claims" as const, arguments: { limit: 5 } };
    await gateway.execute(call);
    await gateway.execute(call);
    expect(port.searchOwnedClaims).toHaveBeenCalledTimes(1);
  });
  it("allows an attachment-first draft with an empty purpose", async () => {
    const port = { createClaimDraft: vi.fn().mockResolvedValue({ id: "claim-1", version: 1, status: "DRAFT", purpose: null }) };
    const store: ToolCallResultStore = { findCompleted: vi.fn().mockResolvedValue(null), saveCompleted: vi.fn() };
    const gateway = new ReimbursementToolGateway(port as never, store);
    await expect(gateway.execute({ actorEmployeeId: "employee-1", actorRole: "EMPLOYEE", channel: "WEB", conversationId: "conversation-1", toolCallId: "turn-1:create_claim_draft", idempotencyKey: "turn-1:create_claim_draft", name: "create_claim_draft", arguments: { purpose: "" } })).resolves.toMatchObject({ claim: { id: "claim-1" } });
    expect(port.createClaimDraft).toHaveBeenCalledWith(expect.objectContaining({ purpose: "" }));
  });
  it("does not retry a completed tool call after a duplicate Feishu message", async () => {
    const port = { createClaimDraft: vi.fn() };
    const store: ToolCallResultStore = {
      findCompleted: vi.fn().mockResolvedValue({ claim: { id: "claim-existing", version: 1, status: "DRAFT", purpose: "客户拜访" } }),
      saveCompleted: vi.fn(),
    };
    const gateway = new ReimbursementToolGateway(port as never, store);

    const result = await gateway.execute({
      actorEmployeeId: "employee-1", actorRole: "EMPLOYEE", channel: "FEISHU", conversationId: "conversation-1", toolCallId: "feishu-message-1:create", idempotencyKey: "feishu-message-1:create",
      name: "create_claim_draft", arguments: { purpose: "客户拜访" },
    });

    expect(result).toEqual({ claim: { id: "claim-existing", version: 1, status: "DRAFT", purpose: "客户拜访" } });
    expect(port.createClaimDraft).not.toHaveBeenCalled();
    expect(store.saveCompleted).not.toHaveBeenCalled();
  });
  it("reports a failed Go tool without recording a completed result", async () => {
    const failure = new Error("Go API unavailable");
    const port = { createClaimDraft: vi.fn().mockRejectedValue(failure) };
    const store: ToolCallResultStore = { findCompleted: vi.fn().mockResolvedValue(null), saveCompleted: vi.fn() };
    const onFailure = vi.fn();
    const gateway = new ReimbursementToolGateway(port as never, store, onFailure);
    const call = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "WEB" as const, conversationId: "conversation-1", toolCallId: "turn-1:create", idempotencyKey: "turn-1:create", name: "create_claim_draft" as const, arguments: { purpose: "" } };

    await expect(gateway.execute(call)).rejects.toBe(failure);
    expect(onFailure).toHaveBeenCalledWith(failure, call);
    expect(store.saveCompleted).not.toHaveBeenCalled();
  });
});
