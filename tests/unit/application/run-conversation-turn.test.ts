import { expect, it, vi } from "vitest";

import { runConversationTurn } from "@/src/application/run-conversation-turn";
import { ReimbursementApiHttpError } from "@/services/agent/src/adapters/reimbursement-api-client";

type Intake = {
  id: string;
  employeeId: string;
  conversationId: string;
  status: "COLLECTING" | "READY_TO_SUBMIT" | "SUBMITTED" | "ABANDONED";
  claimId: string | null;
  collectedFields: Record<string, unknown>;
  pendingFields: string[];
  submissionToken: string | null;
  submissionPreview?: Record<string, unknown> | null;
  restartRequestedAt?: Date | null;
};

function createDeps(overrides: Partial<Record<string, unknown>> = {}) {
  let intake: Intake | null = null;
  const appendMessage = vi.fn(async (input: { text: string }) => ({ id: "message-1", sequence: 1, ...input }));
  const createIntake = vi.fn(async ({ employeeId, conversationId, ...patch }: Pick<Intake, "employeeId" | "conversationId"> & Partial<Intake>) => {
    intake = { id: `intake-${createIntake.mock.calls.length}`, employeeId, conversationId, status: "COLLECTING", claimId: null, collectedFields: {}, pendingFields: ["purpose"], submissionToken: null, ...patch };
    return intake;
  });
  const updateIntake = vi.fn(async (input: Partial<Intake> & { id: string }) => {
    if (!intake) throw new Error("missing intake");
    intake = { ...intake, ...input };
    return intake;
  });
  const restartIntake = vi.fn(async ({ employeeId, conversationId }: { employeeId: string; conversationId: string; intakeId: string; requestedAfter: Date }) => {
    intake = { id: "intake-restarted", employeeId, conversationId, status: "COLLECTING", claimId: null, collectedFields: {}, pendingFields: ["purpose"], submissionToken: null, restartRequestedAt: null };
    return intake;
  });
  const compareAndSetSummary = vi.fn(async () => true);
  const conversations = {
    getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0 }),
    listMessages: async (): Promise<Array<{ sequence: number; role: "USER" | "ASSISTANT" | "SYSTEM"; channel: "WEB" | "FEISHU"; text: string }>> => [],
    appendMessage,
    getCurrentIntake: async () => intake,
    createIntake,
    updateIntake,
    restartIntake,
    compareAndSetSummary,
  };
  const createClaim = vi.fn(async () => ({ id: "agent-claim-1", version: 1 }));
  const uploadReceipt = vi.fn(async () => ({ id: "receipt-1", jobId: "ocr-job-1" }));
  const updatePurpose = vi.fn(async () => ({ version: 2 }));
  const prepareSubmission = vi.fn(async () => ({ token: "confirmation-token", claimId: "agent-claim-1", claimVersion: 2, workbench: { claim: { id: "agent-claim-1", claimNumber: "BX-001", version: 2, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 12_345, totalAmountCent: 12_345, currency: "CNY" as const, receiptCount: 2 }, receipts: [{ id: "r1", claimId: "agent-claim-1", filename: "a.pdf", status: "EXTRACTED", invoiceNumber: "1", ocrConfidence: 0.9, totalAmountCent: 5000 }, { id: "r2", claimId: "agent-claim-1", filename: "b.pdf", status: "EXTRACTED", invoiceNumber: "2", ocrConfidence: 0.9, totalAmountCent: 7345 }] } }));
  const readValidation = vi.fn(async () => ({ claimId: "agent-claim-1", claimVersion: 2, policyVersion: "p1", issues: [] }));
  const submitClaim = vi.fn(async () => ({ submissionNumber: "RB20260001" }));
  return {
    deps: {
      conversations,
      model: { decideConversation: async () => ({ action: "HELP" as const, reply: "好的" }) },
      createClaim,
      preflightAttachment: async () => undefined,
      uploadReceipt,
      updatePurpose,
      readValidation,
      prepareSubmission,
      submitClaim,
      ...overrides,
    },
    getIntake: () => intake,
    appendMessage,
    createClaim,
    uploadReceipt,
    updatePurpose,
    prepareSubmission,
    submitClaim,
    createIntake,
    updateIntake,
    restartIntake,
    compareAndSetSummary,
  };
}

it("answers a policy question without creating an Intake or a claim", async () => {
  const classifyIntent = vi.fn(async () => "POLICY_QUERY" as const);
  const searchPolicy = vi.fn(async () => [{ id: "citation-1", title: "制度", url: "https://example", headingPath: [], excerpt: "住宿上限 500 元", score: 0.9 }]);
  const { deps, createClaim, getIntake } = createDeps({
    searchPolicy,
    model: { classifyIntent, answerPolicy: async () => "住宿上限为 500 元。", decideConversation: async () => ({ action: "POLICY_QUERY" as const, reply: "模型伪造金额999元" }) },
  });

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "住宿上限是多少" }, deps);

  expect(result).toMatchObject({ reply: "住宿上限为 500 元。", citations: [{ id: "citation-1" }], intake: null });
  expect(createClaim).not.toHaveBeenCalled();
  expect(getIntake()).toBeNull();
  expect(searchPolicy).toHaveBeenCalledTimes(1);
  expect(classifyIntent).not.toHaveBeenCalled();
});

it("uses Go rather than policy retrieval for a current-claim standards question", async () => {
  const searchPolicy = vi.fn(async () => []);
  const readWorkbench = vi.fn(async () => ({ claim: { id: "agent-claim-1", claimNumber: "BX-001", version: 2, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 10000, totalAmountCent: 10000, currency: "CNY" as const, receiptCount: 0 }, receipts: [] }));
  const readValidation = vi.fn(async () => ({ claimId: "agent-claim-1", claimVersion: 2, policyVersion: "p1", issues: [] }));
  const { deps } = createDeps({ searchPolicy, readWorkbench, readValidation, model: { decideConversation: async () => ({ action: "READ_SUBMISSION_SUMMARY" as const, reply: "政策片段999元" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "本单住宿是否超标准" }, deps);
  expect(result.reply).not.toContain("999");
  expect(readValidation).toHaveBeenCalledOnce();
  expect(searchPolicy).not.toHaveBeenCalled();
});

it("creates one agent-owned claim on the first attachment and reuses it for later attachments", async () => {
  const { deps, createClaim, uploadReceipt, getIntake } = createDeps();
  const attachment = { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传发票", attachment }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "再上传一张", attachment }, deps);

  expect(createClaim).toHaveBeenCalledTimes(1);
  expect(uploadReceipt).toHaveBeenCalledTimes(2);
  expect(getIntake()).toMatchObject({ claimId: "agent-claim-1" });
});

it("passes an OCR notification target only for a Feishu attachment with a verified chat target", async () => {
  const { deps, uploadReceipt } = createDeps();
  const attachment = { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", chatId: "oc-receipt", channelMessageId: "om-upload", message: "上传发票", attachment }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传发票", attachment }, deps);

  expect(uploadReceipt).toHaveBeenNthCalledWith(1, expect.objectContaining({
    notificationTarget: { conversationId: "conversation-1", chatId: "oc-receipt" },
  }));
  expect(uploadReceipt).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ notificationTarget: expect.anything() }));
});

it("creates the first agent claim with a purpose collected before the attachment", async () => {
  let textTurns = 0;
  const { deps, createClaim, getIntake } = createDeps({
    model: { decideConversation: async () => ++textTurns === 1
      ? { action: "START_INTAKE" as const, reply: "已开始" }
      : { action: "COLLECT_FIELDS" as const, reply: "已记录事由。", fields: { purpose: "客户拜访" } } },
  });
  const attachment = { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "开始报销" }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "客户拜访", }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传发票", attachment }, deps);

  expect(createClaim).toHaveBeenCalledWith({ actorId: "employee-1", purpose: "客户拜访" });
  expect(getIntake()).toMatchObject({ claimId: "agent-claim-1", collectedFields: { purpose: "客户拜访" } });
});

it("creates an Intake for a model-recognized start request and persists an assistant reply", async () => {
  const { deps, createClaim, getIntake, appendMessage } = createDeps({ model: { decideConversation: async () => ({ action: "START_INTAKE" as const, reply: "模型文本不可作为办理结果" }) } });

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "开始报销" }, deps);

  expect(result).toMatchObject({ intake: { id: "intake-1", status: "COLLECTING" } });
  expect(createClaim).not.toHaveBeenCalled();
  expect(getIntake()).toMatchObject({ pendingFields: ["purpose"] });
  expect(appendMessage).toHaveBeenCalledTimes(2);
});

it("asks before replacing an active Intake and restarts only after a second explicit model decision", async () => {
  const { deps, createIntake, updateIntake, restartIntake, getIntake } = createDeps({ model: { decideConversation: async () => ({ action: "START_INTAKE" as const, reply: "已新建" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1" });

  const first = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "新建一笔报销" }, deps);
  expect(first.reply).toContain("正在办理");
  expect(updateIntake).toHaveBeenCalledWith(expect.objectContaining({ restartRequestedAt: expect.any(Date) }));
  expect(createIntake).toHaveBeenCalledTimes(1);
  expect(restartIntake).not.toHaveBeenCalled();
  expect(getIntake()).toMatchObject({ status: "COLLECTING" });

  const second = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "是的，另起一单" }, deps);
  expect(second.reply).toContain("已开始新的");
  expect(restartIntake).toHaveBeenCalledWith(expect.objectContaining({ intakeId: "intake-1", requestedAfter: expect.any(Date) }));
  expect(getIntake()).toMatchObject({ id: "intake-restarted", status: "COLLECTING" });
});

it("expires a restart request and asks again instead of replacing the Intake", async () => {
  const { deps, restartIntake, updateIntake } = createDeps({ model: { decideConversation: async () => ({ action: "START_INTAKE" as const, reply: "已新建" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", restartRequestedAt: new Date(Date.now() - 11 * 60_000) });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "是，另起一单" }, deps);
  expect(result.reply).toContain("正在办理");
  expect(restartIntake).not.toHaveBeenCalled();
  expect(updateIntake).toHaveBeenCalledWith(expect.objectContaining({ restartRequestedAt: expect.any(Date) }));
});

it("clears a pending restart when the employee changes topic", async () => {
  const { deps, updateIntake, restartIntake } = createDeps({ model: { decideConversation: async () => ({ action: "HELP" as const, reply: "已新建" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", restartRequestedAt: new Date() });
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "先说说流程" }, deps);
  expect(updateIntake).toHaveBeenCalledWith(expect.objectContaining({ restartRequestedAt: null }));
  expect(restartIntake).not.toHaveBeenCalled();
});

it("does not expose or replace an Intake that belongs to another conversation", async () => {
  const { deps, createClaim, uploadReceipt } = createDeps({ model: { decideConversation: async () => ({ action: "START_INTAKE" as const, reply: "模型文本不可作为办理结果" }) } });
  const foreign = { id: "intake-private", employeeId: "employee-1", conversationId: "private-conversation", status: "COLLECTING" as const, claimId: "claim-private", collectedFields: {}, pendingFields: ["purpose"], submissionToken: null };
  deps.conversations.getCurrentIntake = async () => foreign;
  deps.conversations.createIntake = vi.fn(async () => { throw new Error("active intake exists"); });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "group-conversation", channel: "FEISHU", chatType: "group", message: "开始报销" }, deps)).resolves.toMatchObject({
    intake: null,
    reply: expect.stringContaining("私聊"),
  });
  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "group-conversation", channel: "FEISHU", chatType: "group", message: "上传票据", attachment: { filename: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([1]) } }, deps)).resolves.toMatchObject({
    intake: null,
    reply: expect.stringContaining("私聊"),
  });
  expect(createClaim).not.toHaveBeenCalled();
  expect(uploadReceipt).not.toHaveBeenCalled();
});

it("writes only allowlisted Intake fields through the claim field use case", async () => {
  const { deps, updatePurpose, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "已记录事由。", fields: { purpose: "客户拜访" } }) },
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: ["purpose"] });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "用于客户拜访" }, deps)).resolves.toMatchObject({
    intake: { collectedFields: { purpose: "客户拜访" } },
  });

  expect(updatePurpose).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1", value: "客户拜访" });
  expect(getIntake()).toMatchObject({ collectedFields: { purpose: "客户拜访" } });
});

it.each(["这张发票金额是 999 元", "你没有读取报销单的权限"])("does not repeat ungrounded model facts: %s", async (reply) => {
  const { deps } = createDeps({ model: { decideConversation: async () => ({ action: "HELP" as const, reply }) } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "当前单据怎么样" }, deps);
  expect(result.reply).not.toContain("999");
  expect(result.reply).not.toContain("没有读取报销单的权限");
  expect(result.reply).toContain("工作台");
});

it.each([
  ["HELP", "工作台"],
  ["CLARIFY", "明确"],
  ["OUT_OF_SCOPE", "报销"],
] as const)("uses a server-owned %s reply", async (action, expected) => {
  const { deps } = createDeps({ model: { decideConversation: async () => ({ action, reply: "金额为999元，已提交" }) } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "请帮我" }, deps);
  expect(result.reply).toContain(expected);
  expect(result.reply).not.toContain("999");
  expect(result.reply).not.toContain("已提交");
});

it("fails closed when the model is unavailable", async () => {
  const searchPolicy = vi.fn();
  const { deps, createClaim, prepareSubmission, submitClaim } = createDeps({ searchPolicy, model: { decideConversation: async () => { throw new Error("provider secret"); } } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "新建报销" }, deps);
  expect(result.reply).toContain("暂时");
  expect(result.reply).not.toContain("provider secret");
  expect(searchPolicy).not.toHaveBeenCalled();
  expect(createClaim).not.toHaveBeenCalled();
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(submitClaim).not.toHaveBeenCalled();
});

it("acknowledges the persisted purpose rather than a fabricated model reply", async () => {
  const { deps } = createDeps({ model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "已写入金额 999 元", fields: { purpose: "客户拜访" } }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "报销事由是客户拜访" }, deps);
  expect(result.reply).toContain("客户拜访");
  expect(result.reply).not.toContain("999");
});

it("reads current Go facts for an amount question without trusting the model reply", async () => {
  const readWorkbench = vi.fn(async () => ({ claim: { id: "agent-claim-1", claimNumber: "BX-001", version: 2, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 12345, totalAmountCent: 10155, currency: "CNY" as const, receiptCount: 1 }, receipts: [{ id: "receipt-1", claimId: "agent-claim-1", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.97, totalAmountCent: 10155 }] }));
  const { deps } = createDeps({ readWorkbench, model: { decideConversation: async () => ({ action: "READ_RECEIPT_AMOUNT" as const, reply: "没有权限，金额为999元" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "发票多少钱" }, deps);
  expect(result.reply).toContain("¥101.55");
  expect(result.reply).not.toContain("999");
  expect(readWorkbench).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1" });
});

it("asks to start an Intake when no claim is bound instead of reading an arbitrary claim", async () => {
  const readWorkbench = vi.fn();
  const { deps } = createDeps({ readWorkbench, model: { decideConversation: async () => ({ action: "READ_CLAIM" as const, reply: "金额999元" }) } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "申请报销总额多少" }, deps);
  expect(result.reply).toContain("开始报销");
  expect(readWorkbench).not.toHaveBeenCalled();
});

it("keeps a submission summary read-only", async () => {
  const workbench = { claim: { id: "agent-claim-1", claimNumber: "BX-001", version: 2, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 12345, totalAmountCent: 10155, currency: "CNY" as const, receiptCount: 1 }, receipts: [{ id: "receipt-1", claimId: "agent-claim-1", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.97, totalAmountCent: 10155 }] };
  const readValidation = vi.fn(async () => ({ claimId: "agent-claim-1", claimVersion: 2, policyVersion: "p1", issues: [{ code: "PURPOSE", severity: "WARNING" as const, message: "请确认事由" }] }));
  const { deps, prepareSubmission, updateIntake } = createDeps({ readWorkbench: async () => workbench, readValidation, model: { decideConversation: async () => ({ action: "READ_SUBMISSION_SUMMARY" as const, reply: "已经提交" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "生成提交摘要" }, deps);
  expect(result.reply).toContain("只读摘要");
  expect(result.reply).toContain("请确认事由");
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(updateIntake).not.toHaveBeenCalled();
  expect(readValidation).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1" });
});

it("does not interpret a Go read failure as lack of permission", async () => {
  const { deps } = createDeps({ readWorkbench: async () => { throw new Error("upstream unavailable"); }, model: { decideConversation: async () => ({ action: "READ_CLAIM" as const, reply: "无权限" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "申请报销总额多少" }, deps);
  expect(result.reply).toContain("暂时无法查询");
  expect(result.reply).not.toContain("无权限");
});

it("does not reveal whether a 404 claim exists when reading facts", async () => {
  const { deps } = createDeps({ readWorkbench: async () => { throw new ReimbursementApiHttpError("private backend detail", 404, "NOT_FOUND"); }, model: { decideConversation: async () => ({ action: "READ_CLAIM" as const, reply: "单据存在" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "申请报销总额" }, deps);
  expect(result.reply).toContain("无法访问当前报销单");
  expect(result.reply).not.toContain("单据存在");
  expect(result.reply).not.toContain("private backend detail");
});

it.each(["START_INTAKE", "COLLECT_FIELDS", "READ_CLAIM", "READ_RECEIPT_AMOUNT", "READ_SUBMISSION_SUMMARY", "PREPARE_SUBMISSION"] as const)("keeps %s private in a Feishu group", async (action) => {
  const readWorkbench = vi.fn();
  const readValidation = vi.fn();
  const prepareSubmission = vi.fn();
  const { deps, createIntake, updateIntake } = createDeps({ readWorkbench, readValidation, prepareSubmission, model: { decideConversation: async () => ({ action, reply: "金额为999元", ...(action === "COLLECT_FIELDS" ? { fields: { purpose: "客户拜访" } } : {}) }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "group", message: "@机器人 帮我看看报销" }, deps);
  expect(result.reply).toContain("私聊");
  expect(result.reply).not.toContain("999");
  expect(result.intake).toBeNull();
  expect(readWorkbench).not.toHaveBeenCalled();
  expect(readValidation).not.toHaveBeenCalled();
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(createIntake).toHaveBeenCalledTimes(1);
  expect(updateIntake).not.toHaveBeenCalled();
});

it("never submits on a group confirmation even when a token exists", async () => {
  const { deps, submitClaim } = createDeps();
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", status: "READY_TO_SUBMIT", submissionToken: "token-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "group", message: "确认提交" }, deps);
  expect(result.reply).toContain("私聊");
  expect(result.intake).toBeNull();
  expect(submitClaim).not.toHaveBeenCalled();
});

it("fails closed when a Feishu confirmation has no trusted chat type", async () => {
  const { deps, submitClaim } = createDeps();
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", status: "READY_TO_SUBMIT", submissionToken: "token-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", message: "确认提交" }, deps);
  expect(result.reply).toContain("私聊");
  expect(submitClaim).not.toHaveBeenCalled();
});

it("does not request a confirmation token when Go validation blocks submission", async () => {
  const prepareSubmission = vi.fn();
  const { deps, getIntake } = createDeps({ prepareSubmission, readValidation: async () => ({ claimId: "agent-claim-1", claimVersion: 2, policyVersion: "p1", issues: [{ code: "AMOUNT_REQUIRED", severity: "BLOCKING" as const, message: "请填写申请金额" }] }), model: { decideConversation: async () => ({ action: "PREPARE_SUBMISSION" as const, reply: "直接提交" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "我要提交" }, deps);
  expect(result.reply).toContain("请填写申请金额");
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(getIntake()).toMatchObject({ status: "COLLECTING", submissionToken: null });
});

it("prepares a fresh token and displays Go's current amount before asking confirmation", async () => {
  const workbench = { claim: { id: "agent-claim-1", claimNumber: "BX-001", version: 3, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 12345, totalAmountCent: 10155, currency: "CNY" as const, receiptCount: 1 }, receipts: [{ id: "receipt-1", claimId: "agent-claim-1", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.97, totalAmountCent: 10155 }] };
  const prepareSubmission = vi.fn(async () => ({ token: "token-3", claimId: "agent-claim-1", claimVersion: 3, workbench }));
  const { deps, getIntake } = createDeps({ prepareSubmission, readValidation: async () => ({ claimId: "agent-claim-1", claimVersion: 3, policyVersion: "p1", issues: [] }), model: { decideConversation: async () => ({ action: "PREPARE_SUBMISSION" as const, reply: "金额999元" }) } });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "我要提交" }, deps);
  expect(result.reply).toContain("¥123.45");
  expect(result.reply).toContain("确认提交");
  expect(result.reply).not.toContain("999");
  expect(prepareSubmission).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1" });
  expect(getIntake()).toMatchObject({ status: "READY_TO_SUBMIT", submissionToken: "token-3" });
});

it("guides an unprepared confirmation without throwing or submitting", async () => {
  const { deps, submitClaim } = createDeps();
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, deps);
  expect(result.reply).toContain("先发起提交");
  expect(submitClaim).not.toHaveBeenCalled();
});

it.each([["VERSION_CONFLICT", "单据已变化"], ["CONFIRMATION_EXPIRED", "确认已过期"]])("invalidates stale confirmation on %s", async (code, expected) => {
  const submitClaim = vi.fn(async () => { throw new ReimbursementApiHttpError("Go detail", 409, code); });
  const { deps, getIntake } = createDeps({ submitClaim });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", status: "READY_TO_SUBMIT", submissionToken: "old-token" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "确认提交" }, deps);
  expect(result.reply).toContain(expected);
  expect(getIntake()).toMatchObject({ status: "COLLECTING", submissionToken: null });
});

it("submits exactly once only after the server has prepared the active Intake", async () => {
  const { deps, prepareSubmission, submitClaim, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "PREPARE_SUBMISSION" as const, reply: "请确认提交。" }) },
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: [] });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "可以提交了吗" }, deps)).resolves.toMatchObject({
    reply: expect.stringContaining("¥123.45"),
    intake: { status: "READY_TO_SUBMIT", submissionPreview: { totalAmountCents: 12_345, receiptCount: 2, purpose: "客户拜访" } },
  });
  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, deps)).resolves.toMatchObject({
    submissionNumber: "RB20260001",
    intake: { status: "SUBMITTED" },
  });
  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, deps)).resolves.toMatchObject({ reply: expect.stringContaining("先发起提交") });

  expect(prepareSubmission).toHaveBeenCalledTimes(1);
  expect(submitClaim).toHaveBeenCalledTimes(1);
  expect(getIntake()).toMatchObject({ status: "SUBMITTED" });
});

it("keeps the conversation responsive when server-side submission validation blocks confirmation", async () => {
  const { deps, appendMessage, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "PREPARE_SUBMISSION" as const, reply: "请确认提交。" }) },
    readValidation: async () => ({ claimId: "agent-claim-1", claimVersion: 2, policyVersion: "p1", issues: [{ code: "AMOUNT_REQUIRED", severity: "BLOCKING" as const, message: "请填写申请金额" }] }),
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: [] });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", channelMessageId: "message-validation-blocked", message: "可以提交了吗" }, deps)).resolves.toMatchObject({
    reply: expect.stringContaining("暂时不能提交"),
    intake: { status: "COLLECTING" },
  });

  expect(appendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    role: "ASSISTANT",
    inReplyToChannelMessageId: "message-validation-blocked",
  }));
  expect(getIntake()).toMatchObject({ status: "COLLECTING" });
});

it("invalidates a prepared submission when another attachment changes the claim", async () => {
  const { deps, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "PREPARE_SUBMISSION" as const, reply: "请确认提交。" }) },
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: [] });
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "可以提交了吗" }, deps);

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "补一张票据", attachment: { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1]) } }, deps);

  expect(getIntake()).toMatchObject({ status: "COLLECTING", submissionToken: null, submissionPreview: null });
});

it("rolls older conversation messages into a bounded summary before model routing", async () => {
  let receivedSummary = "";
  const { deps, compareAndSetSummary } = createDeps({
    model: { decideConversation: async (context: { summary: { text: string } }) => { receivedSummary = context.summary.text; return { action: "HELP" as const, reply: "好的" }; } },
  });
  deps.conversations.listMessages = async () => Array.from({ length: 16 }, (_, index) => ({ sequence: index + 1, role: "USER" as const, channel: "WEB" as const, text: `历史消息 ${index + 1}` }));
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "继续办理" }, deps);

  expect(compareAndSetSummary).toHaveBeenCalledWith(expect.objectContaining({ expectedThroughSequence: 0, throughSequence: 4 }));
  expect(receivedSummary).toContain("历史消息 1");
});
