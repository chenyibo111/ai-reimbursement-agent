import { expect, it, vi } from "vitest";

import { runAgentTurn } from "@/src/application/run-agent-turn";

it("persists only a valid mapped proposal", async () => {
  const createProposal = vi.fn().mockResolvedValue({ id: "proposal-1", target: "claim", field: "purpose", displayValue: "客户拜访", reason: "补齐事由", status: "PENDING", claimVersion: 2 });
  const result = await runAgentTurn(
    { actorId: "employee-1", claimId: "claim-1", message: "客户拜访" },
    {
      model: { decide: async () => ({ reply: "请确认事由", proposals: [{ target: "claim", field: "purpose", value: "客户拜访", reason: "补齐事由" }] }) },
      getContext: async () => ({ summary: { purpose: null, totalAmountCents: 0, expenses: [] }, issues: [], allowedTargets: [{ target: "claim", fields: ["purpose"] }], targetMap: {}, claimVersion: 2 }),
      createProposal,
      audit: { append: async () => undefined },
    },
  );

  expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({ target: "claim", field: "purpose", claimVersion: 2 }));
  expect(result.proposals).toEqual([expect.objectContaining({ id: "proposal-1", status: "PENDING" })]);
});

it("rejects unavailable model proposals without creating a field mutation", async () => {
  const append = vi.fn();
  const createProposal = vi.fn();
  const result = await runAgentTurn(
    { actorId: "employee-1", claimId: "claim-1", message: "继续" },
    {
      model: { decide: async () => ({ reply: "已处理", proposals: [{ target: "claim", field: "invoiceNumber", value: "NO-1", reason: "越权" }] }) },
      getContext: async () => ({ summary: { purpose: null, totalAmountCents: 0, expenses: [] }, issues: [
        { code: "CONFIRM_INVOICE_NUMBER", severity: "BLOCKING" as const },
      ], allowedTargets: [{ target: "claim", fields: ["purpose"] }], targetMap: {}, claimVersion: 2 }),
      createProposal,
      audit: { append },
    },
  );

  expect(createProposal).not.toHaveBeenCalled();
  expect(result.proposals).toEqual([]);
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "MODEL_RESPONSE_REJECTED" }));
});
