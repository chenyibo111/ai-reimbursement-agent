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

it("returns only server-approved citations for a policy question", async () => {
  const answerPolicy = vi.fn(async () => "住宿费用请以制度规定的上限为准。");
  const result = await runAgentTurn({ actorId: "employee-1", claimId: "claim-1", message: "报销政策是什么" }, { model: { decide: async () => { throw new Error("must not call model"); }, answerPolicy }, getContext: async () => ({ summary: { purpose: null, totalAmountCents: 0, expenses: [] }, issues: [], allowedTargets: [], targetMap: {}, claimVersion: 1 }), createProposal: async () => { throw new Error("must not create"); }, audit: { append: async () => undefined }, searchPolicy: async () => [{ id: "safe", title: "制度", url: "https://example", excerpt: "住宿上限", headingPath: [], score: 0.9 }] });
  expect(result).toMatchObject({ proposals: [], citations: [{ id: "safe" }] });
  expect(result.reply).toBe("住宿费用请以制度规定的上限为准。");
  expect(answerPolicy).toHaveBeenCalledWith({
    question: "报销政策是什么",
    sources: [{ title: "制度", excerpt: "住宿上限", headingPath: [] }],
  });
});

it("treats a reimbursement rule question as a policy knowledge query", async () => {
  const searchPolicy = vi.fn(async () => [{ id: "safe", title: "制度", url: "https://example", excerpt: "住宿上限", headingPath: [], score: 0.9 }]);
  const result = await runAgentTurn({ actorId: "employee-1", claimId: "claim-1", message: "住宿费报销规则是怎么样的" }, {
    model: { decide: async () => { throw new Error("must not call model"); } },
    getContext: async () => ({ summary: { purpose: null, totalAmountCents: 0, expenses: [] }, issues: [], allowedTargets: [], targetMap: {}, claimVersion: 1 }),
    createProposal: async () => { throw new Error("must not create"); },
    audit: { append: async () => undefined },
    searchPolicy,
  });

  expect(result.citations).toEqual([expect.objectContaining({ id: "safe" })]);
  expect(searchPolicy).toHaveBeenCalledWith("住宿费报销规则是怎么样的");
});

it("uses the model intent classifier for a policy question without policy keywords", async () => {
  const searchPolicy = vi.fn(async () => [{ id: "safe", title: "制度", url: "https://example", excerpt: "住宿上限", headingPath: [], score: 0.9 }]);
  const result = await runAgentTurn({ actorId: "employee-1", claimId: "claim-1", message: "酒店住宿上限是多少" }, {
    model: {
      decide: async () => { throw new Error("must not call agent model"); },
      classifyIntent: async () => "POLICY_QUERY",
    },
    getContext: async () => ({ summary: { purpose: null, totalAmountCents: 0, expenses: [] }, issues: [], allowedTargets: [], targetMap: {}, claimVersion: 1 }),
    createProposal: async () => { throw new Error("must not create"); },
    audit: { append: async () => undefined },
    searchPolicy,
  });

  expect(result.citations).toEqual([expect.objectContaining({ id: "safe" })]);
  expect(searchPolicy).toHaveBeenCalledWith("酒店住宿上限是多少");
});
