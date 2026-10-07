import { describe, expect, it, vi } from "vitest";

import { createConversationReimbursementTools } from "./conversation-reimbursement";

describe("createConversationReimbursementTools", () => {
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
