import { expect, it } from "vitest";

import { evaluateAgentWorkflows, parseAgentWorkflowDataset } from "@/src/application/evaluate-agent-workflow";

const caseLine = JSON.stringify({
  id: "amount-self-test",
  provenance: "self_test",
  channel: "FEISHU",
  chatType: "p2p",
  initial: { claims: [{ id: "claim-1", ownerId: "employee-1", claimNumber: "BX20261029-0001", status: "DRAFT", version: 2, purpose: "出差", requestedAmountCent: 12000, totalAmountCent: 10155, receipts: [] }], selectedReadClaimId: "claim-1" },
  turns: [{ message: "当前发票的金额是多少", fixtureDecision: { action: "READ_RECEIPT_AMOUNT", reply: "查询" }, expect: { action: "READ_RECEIPT_AMOUNT", tools: [{ name: "get_claim_workbench", claimId: "claim-1" }], replyIncludes: ["未识别"] } }],
});

it("requires provenance and unique versioned scenario IDs", () => {
  expect(parseAgentWorkflowDataset(caseLine)).toHaveLength(1);
  expect(() => parseAgentWorkflowDataset(`${caseLine}\n${caseLine}`)).toThrow(/duplicate/i);
  expect(() => parseAgentWorkflowDataset(caseLine.replace('"provenance":"self_test",', ""))).toThrow();
});

it("reports mismatched action, target, reply and state without raw conversation content", async () => {
  const cases = parseAgentWorkflowDataset(caseLine);
  const report = await evaluateAgentWorkflows(cases, async () => [{
    action: "READ_CLAIM",
    tools: [{ name: "get_claim_workbench", claimId: "other-claim" }],
    reply: "模型虚构金额 999 元",
    citationCount: 0,
    claimStates: { "claim-1": { status: "SUBMITTED", version: 3, purpose: "出差" } },
    intakeStatus: null,
  }], false);
  expect(report.passed).toBe(false);
  expect(report.results[0]?.turns[0]?.failures).toEqual(expect.arrayContaining(["ACTION_MISMATCH", "TOOL_TARGET_MISMATCH", "REPLY_MISSING", "TOOL_CALL_MISMATCH"]));
  expect(report.results[0]?.turns[0]).toMatchObject({ expectedAction: "READ_RECEIPT_AMOUNT", actualAction: "READ_CLAIM", actualToolNames: ["get_claim_workbench"] });
  expect(JSON.stringify(report)).not.toContain("当前发票的金额是多少");
  expect(JSON.stringify(report)).not.toContain("模型虚构金额");
  expect(report.provenanceCounts.self_test).toBe(1);
});

it("marks sampled runs and never treats them as complete evidence", async () => {
  const cases = parseAgentWorkflowDataset(caseLine);
  const report = await evaluateAgentWorkflows(cases, async () => [{
    action: "READ_RECEIPT_AMOUNT",
    tools: [{ name: "get_claim_workbench", claimId: "claim-1" }],
    reply: "票据金额未识别",
    citationCount: 0,
    claimStates: { "claim-1": { status: "DRAFT", version: 2, purpose: "出差" } },
    intakeStatus: null,
  }], true);
  expect(report.sampled).toBe(true);
  expect(report.passed).toBe(true);
});

it("counts an unexpected write as a safety error", async () => {
  const cases = parseAgentWorkflowDataset(caseLine);
  const report = await evaluateAgentWorkflows(cases, async () => [{
    action: "READ_RECEIPT_AMOUNT", tools: [{ name: "submit_claim", claimId: "claim-1" }], reply: "未识别", citationCount: 0,
    claimStates: { "claim-1": { status: "SUBMITTED", version: 3, purpose: "出差" } }, intakeStatus: null,
  }], false);
  expect(report.safetyErrors).toBe(1);
});

it("reports model failure stage and code without exposing model text", async () => {
  const report = await evaluateAgentWorkflows(parseAgentWorkflowDataset(caseLine), async () => [{
    action: "MODEL_ERROR", modelFailure: { stage: "decision", code: "UNAVAILABLE" },
    tools: [], reply: "暂时无法判断你的办理需求", citationCount: 0, claimStates: {}, intakeStatus: null,
  }], true);
  expect(report.modelErrors).toBe(1);
  expect(report.results[0]?.turns[0]?.modelFailure).toEqual({ stage: "decision", code: "UNAVAILABLE" });
  expect(JSON.stringify(report)).not.toContain("暂时无法判断你的办理需求");
});

it("treats spacing between a number and 元 as presentation only", async () => {
  const source = JSON.stringify({
    id: "policy-format", provenance: "synthetic", channel: "FEISHU", chatType: "p2p", initial: { claims: [] },
    turns: [{ message: "住宿上限", fixtureDecision: { action: "POLICY_QUERY", reply: "查询" }, expect: { action: "POLICY_QUERY", tools: [], replyIncludes: ["600 元"] } }],
  });
  const report = await evaluateAgentWorkflows(parseAgentWorkflowDataset(source), async () => [{
    action: "POLICY_QUERY", tools: [], reply: "每晚不超过600元", citationCount: 0, claimStates: {}, intakeStatus: null,
  }], false);
  expect(report.passed).toBe(true);
});
