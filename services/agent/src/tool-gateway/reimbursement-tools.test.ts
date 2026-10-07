import { describe, expect, it, vi } from "vitest";

import { ReimbursementToolGateway, type ToolCallResultStore } from "./reimbursement-tools";

describe("ReimbursementToolGateway", () => {
  it("does not retry a completed tool call after a duplicate Feishu message", async () => {
    const port = { createClaimDraft: vi.fn() };
    const store: ToolCallResultStore = {
      findCompleted: vi.fn().mockResolvedValue({ claim: { id: "claim-existing", version: 1, status: "DRAFT", purpose: "客户拜访" } }),
      saveCompleted: vi.fn(),
    };
    const gateway = new ReimbursementToolGateway(port as never, store);

    const result = await gateway.execute({
      actorEmployeeId: "employee-1", channel: "FEISHU", conversationId: "conversation-1", toolCallId: "feishu-message-1:create", idempotencyKey: "feishu-message-1:create",
      name: "create_claim_draft", arguments: { purpose: "客户拜访" },
    });

    expect(result).toEqual({ claim: { id: "claim-existing", version: 1, status: "DRAFT", purpose: "客户拜访" } });
    expect(port.createClaimDraft).not.toHaveBeenCalled();
    expect(store.saveCompleted).not.toHaveBeenCalled();
  });
});
