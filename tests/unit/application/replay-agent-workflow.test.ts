import { expect, it } from "vitest";

import { parseAgentWorkflowDataset } from "@/src/application/evaluate-agent-workflow";
import { replayAgentWorkflow } from "@/src/application/replay-agent-workflow";
import { ChatModelError } from "@/src/infrastructure/model/openai-compatible-chat-model";

const claim = { id: "claim-1", ownerId: "employee-1", claimNumber: "BX20261029-0001", status: "DRAFT", version: 2, purpose: "出差", requestedAmountCent: 12000, totalAmountCent: 10155, receipts: [{ id: "r1", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.9, totalAmountCent: 10155 }] };

it("replays private read through production gateway without external services", async () => {
  const [scenario] = parseAgentWorkflowDataset(JSON.stringify({ id: "read", provenance: "synthetic", channel: "FEISHU", chatType: "p2p", initial: { claims: [claim], selectedReadClaimId: "claim-1" }, turns: [{ message: "当前发票金额", fixtureDecision: { action: "READ_RECEIPT_AMOUNT", reply: "查金额" }, expect: { action: "READ_RECEIPT_AMOUNT", tools: [{ name: "get_claim_workbench", claimId: "claim-1" }], replyIncludes: ["101.55"] } }] }));
  const [turn] = await replayAgentWorkflow(scenario);
  expect(turn.action).toBe("READ_RECEIPT_AMOUNT");
  expect(turn.tools).toEqual([{ name: "get_claim_workbench", claimId: "claim-1" }]);
  expect(turn.reply).toContain("101.55");
});

it("requires explicit confirmation and protects group conversations", async () => {
  const privateCase = parseAgentWorkflowDataset(JSON.stringify({ id: "submit", provenance: "synthetic", channel: "FEISHU", chatType: "p2p", initial: { claims: [claim], selectedEditClaimId: "claim-1" }, turns: [
    { message: "提交报销", fixtureDecision: { action: "PREPARE_SUBMISSION", reply: "发起" }, expect: { action: "PREPARE_SUBMISSION", tools: [], replyIncludes: [] } },
    { message: "确认提交", expect: { action: "CONFIRM_SUBMISSION", tools: [], replyIncludes: [] } },
  ] }))[0];
  const [prepare, confirm] = await replayAgentWorkflow(privateCase);
  expect(prepare.claimStates["claim-1"].status).toBe("DRAFT");
  expect(prepare.tools.map((tool) => tool.name)).toContain("request_submission_confirmation");
  expect(confirm.tools.map((tool) => tool.name)).toContain("submit_claim");
  expect(confirm.claimStates["claim-1"].status).toBe("SUBMITTED");

  const groupCase = parseAgentWorkflowDataset(JSON.stringify({ ...privateCase, id: "group", chatType: "group", turns: [privateCase.turns[0]] }))[0];
  const [group] = await replayAgentWorkflow(groupCase);
  expect(group.tools).toEqual([]);
  expect(group.reply).toContain("请私聊");
});

it("cannot read a different employee's claim by number", async () => {
  const [scenario] = parseAgentWorkflowDataset(JSON.stringify({ id: "foreign", provenance: "synthetic", channel: "FEISHU", chatType: "p2p", initial: { claims: [{ ...claim, ownerId: "other-employee" }] }, turns: [{ message: "查 BX20261029-0001", fixtureDecision: { action: "READ_CLAIM", reply: "读取", claimNumber: "BX20261029-0001" }, expect: { action: "READ_CLAIM", tools: [], replyIncludes: ["未找到"] } }] }));
  const [turn] = await replayAgentWorkflow(scenario);
  expect(turn.tools.map((tool) => tool.name)).toEqual(["find_owned_claim_by_number"]);
  expect(turn.reply).toContain("无权访问");
});

it("identifies a policy answer failure even when the service falls back to citations", async () => {
  const [scenario] = parseAgentWorkflowDataset(JSON.stringify({
    id: "policy-fallback", provenance: "synthetic", channel: "FEISHU", chatType: "p2p",
    initial: { claims: [], policy: { answer: "600 元", evidenceText: "北京上海不超过 600 元", citationTitle: "差旅", citationUrl: "https://example.invalid" } },
    turns: [{ message: "住宿费标准", expect: { action: "POLICY_QUERY", tools: [], replyIncludes: ["600 元"], citationCount: 1 } }],
  }));
  const [turn] = await replayAgentWorkflow(scenario, {
    decideConversation: async () => ({ action: "POLICY_QUERY", reply: "查询" }),
    answerPolicy: async () => { throw new ChatModelError("private provider text", "UNAVAILABLE"); },
  });
  expect(turn.modelFailure).toEqual({ stage: "policy_answer", code: "UNAVAILABLE" });
  expect(turn.citationCount).toBe(1);
  expect(turn.reply).toContain("以引用章节为准");
});

it("passes selected draft capability to the model for edit and submit decisions", async () => {
  const [scenario] = parseAgentWorkflowDataset(JSON.stringify({ id: "selected-context", provenance: "synthetic", channel: "FEISHU", chatType: "p2p", initial: { claims: [claim], selectedEditClaimId: "claim-1", selectedReadClaimId: "claim-1" }, turns: [
    { message: "把报销事由改成客户拜访", expect: { action: "COLLECT_FIELDS", tools: [], replyIncludes: [] } },
    { message: "请提交这张报销单", expect: { action: "PREPARE_SUBMISSION", tools: [], replyIncludes: [] } },
  ] }));
  const contexts: Array<import("@/src/application/build-conversation-context").ConversationContext> = [];
  await replayAgentWorkflow(scenario, { decideConversation: async (context) => {
    contexts.push(context);
    return contexts.length === 1 ? { action: "COLLECT_FIELDS", reply: "保存", fields: { purpose: "客户拜访" } } : { action: "PREPARE_SUBMISSION", reply: "准备" };
  } });
  expect(contexts).toHaveLength(2);
  expect(contexts.every((context) => context.selection?.hasEditDraft && !context.selection.readEditConflict)).toBe(true);
  expect(contexts[0]?.allowedFields).toContain("purpose");
  expect(JSON.stringify(contexts)).not.toContain("claim-1");
});
