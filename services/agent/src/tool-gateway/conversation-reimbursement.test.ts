import { describe, expect, it, vi } from "vitest";

import { createConversationReimbursementTools } from "./conversation-reimbursement";

describe("createConversationReimbursementTools", () => {
  it("uses the internal object-store endpoint while preserving the signed public host", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ upload: { receiptId: "receipt-1", uploadUrl: "http://localhost:9000/reimbursement-private/receipts/receipt-1?X-Amz-Signature=secret" } })
      .mockResolvedValueOnce({ receipt: { receiptId: "receipt-1", status: "READY_FOR_OCR" } });
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const tools = createConversationReimbursementTools({ execute } as never, fetcher, "http://minio:9000");

    await expect(tools.uploadReceipt({ actorId: "employee-1", actorRole: "EMPLOYEE", conversationId: "conversation-1", channelMessageId: "message-1" }, "claim-1", {
      filename: "receipt.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3]),
    })).resolves.toEqual({ receiptId: "receipt-1", status: "READY_FOR_OCR" });

    expect(fetcher).toHaveBeenCalledWith(
      "http://minio:9000/reimbursement-private/receipts/receipt-1?X-Amz-Signature=secret",
      expect.objectContaining({ headers: { "Content-Type": "application/pdf", Host: "localhost:9000" }, signal: expect.any(AbortSignal) }),
    );
  });

  it("reads the current Go version before updating a conversational purpose", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ workbench: { claim: { version: 4 } } })
      .mockResolvedValueOnce({ claim: { version: 5 } });
    const tools = createConversationReimbursementTools({ execute } as never);

    await expect(tools.updatePurpose({ actorId: "employee-1", conversationId: "conversation-1", channelMessageId: "message-1" }, "claim-1", "客户拜访")).resolves.toEqual({ version: 5 });
    expect(execute.mock.calls.map(([call]) => call.name)).toEqual(["get_claim_workbench", "update_claim_fields"]);
    expect(execute.mock.calls[1][0].arguments).toMatchObject({ claimId: "claim-1", version: 4, purpose: "客户拜访" });
  });
});
