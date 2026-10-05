import { expect, it, vi } from "vitest";

import { runConversationTurn } from "@/src/application/run-conversation-turn";

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
  const compareAndSetSummary = vi.fn(async () => true);
  const conversations = {
    getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0 }),
    listMessages: async (): Promise<Array<{ sequence: number; role: "USER" | "ASSISTANT" | "SYSTEM"; channel: "WEB" | "FEISHU"; text: string }>> => [],
    appendMessage,
    getCurrentIntake: async () => intake,
    createIntake,
    updateIntake,
    compareAndSetSummary,
  };
  const createClaim = vi.fn(async () => ({ id: "agent-claim-1", version: 1 }));
  const uploadReceipt = vi.fn(async () => ({ id: "receipt-1", jobId: "ocr-job-1" }));
  const updatePurpose = vi.fn(async () => ({ version: 2 }));
  const requestSubmission = vi.fn(async () => ({ token: "confirmation-token", claimId: "agent-claim-1", claimVersion: 2, totalAmountCents: 12_345, receiptCount: 2, purpose: "客户拜访", issues: [] }));
  const submitClaim = vi.fn(async () => ({ submissionNumber: "RB20260001" }));
  return {
    deps: {
      conversations,
      model: { decideConversation: async () => ({ action: "ANSWER" as const, reply: "好的" }) },
      createClaim,
      preflightAttachment: async () => undefined,
      uploadReceipt,
      updatePurpose,
      requestSubmission,
      submitClaim,
      ...overrides,
    },
    getIntake: () => intake,
    appendMessage,
    createClaim,
    uploadReceipt,
    updatePurpose,
    requestSubmission,
    submitClaim,
    createIntake,
    updateIntake,
    compareAndSetSummary,
  };
}

it("answers a policy question without creating an Intake or a claim", async () => {
  const { deps, createClaim, getIntake } = createDeps({
    searchPolicy: async () => [{ id: "citation-1", title: "制度", url: "https://example", headingPath: [], excerpt: "住宿上限 500 元", score: 0.9 }],
    model: { classifyIntent: async () => "POLICY_QUERY" as const, answerPolicy: async () => "住宿上限为 500 元。", decideConversation: async () => { throw new Error("must not decide"); } },
  });

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "住宿上限是多少" }, deps);

  expect(result).toMatchObject({ reply: "住宿上限为 500 元。", citations: [{ id: "citation-1" }], intake: null });
  expect(createClaim).not.toHaveBeenCalled();
  expect(getIntake()).toBeNull();
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

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatId: "oc-receipt", channelMessageId: "om-upload", message: "上传发票", attachment }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传发票", attachment }, deps);

  expect(uploadReceipt).toHaveBeenNthCalledWith(1, expect.objectContaining({
    notificationTarget: { conversationId: "conversation-1", chatId: "oc-receipt" },
  }));
  expect(uploadReceipt).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ notificationTarget: expect.anything() }));
});

it("creates the first agent claim with a purpose collected before the attachment", async () => {
  const { deps, createClaim, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "已记录事由。", fields: { purpose: "客户拜访" } }) },
  });
  const attachment = { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "开始报销" }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "客户拜访", }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传发票", attachment }, deps);

  expect(createClaim).toHaveBeenCalledWith({ actorId: "employee-1", purpose: "客户拜访" });
  expect(getIntake()).toMatchObject({ claimId: "agent-claim-1", collectedFields: { purpose: "客户拜访" } });
});

it("creates an Intake only for an explicit start command and persists an assistant reply", async () => {
  const { deps, createClaim, getIntake, appendMessage } = createDeps();

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "开始报销" }, deps);

  expect(result).toMatchObject({ intake: { id: "intake-1", status: "COLLECTING" } });
  expect(createClaim).not.toHaveBeenCalled();
  expect(getIntake()).toMatchObject({ pendingFields: ["purpose"] });
  expect(appendMessage).toHaveBeenCalledTimes(2);
});

it("abandons the current Intake in the same conversation before starting a new one", async () => {
  const { deps, createIntake, updateIntake, getIntake } = createDeps();
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1" });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "开始报销" }, deps)).resolves.toMatchObject({
    reply: expect.stringContaining("已开始新的"),
    intake: { status: "COLLECTING" },
  });

  expect(updateIntake).toHaveBeenCalledWith(expect.objectContaining({ status: "ABANDONED", submissionToken: null, submissionPreview: null }));
  expect(createIntake).toHaveBeenCalledTimes(2);
  expect(getIntake()).toMatchObject({ status: "COLLECTING" });
});

it("does not expose or replace an Intake that belongs to another conversation", async () => {
  const { deps, createClaim, uploadReceipt } = createDeps();
  const foreign = { id: "intake-private", employeeId: "employee-1", conversationId: "private-conversation", status: "COLLECTING" as const, claimId: "claim-private", collectedFields: {}, pendingFields: ["purpose"], submissionToken: null };
  deps.conversations.getCurrentIntake = async () => foreign;
  deps.conversations.createIntake = vi.fn(async () => { throw new Error("active intake exists"); });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "group-conversation", channel: "FEISHU", message: "开始报销" }, deps)).resolves.toMatchObject({
    intake: null,
    reply: expect.stringContaining("另一会话"),
  });
  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "group-conversation", channel: "FEISHU", message: "上传票据", attachment: { filename: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([1]) } }, deps)).resolves.toMatchObject({
    intake: null,
    reply: expect.stringContaining("另一会话"),
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

it("submits exactly once only after the server has prepared the active Intake", async () => {
  const { deps, requestSubmission, submitClaim, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "REQUEST_SUBMISSION" as const, reply: "请确认提交。" }) },
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: [] });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "可以提交了吗" }, deps)).resolves.toMatchObject({
    intake: { status: "READY_TO_SUBMIT", submissionPreview: { totalAmountCents: 12_345, receiptCount: 2, purpose: "客户拜访" } },
  });
  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, deps)).resolves.toMatchObject({
    submissionNumber: "RB20260001",
    intake: { status: "SUBMITTED" },
  });
  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, deps)).rejects.toThrow("no ready Intake");

  expect(requestSubmission).toHaveBeenCalledTimes(1);
  expect(submitClaim).toHaveBeenCalledTimes(1);
  expect(getIntake()).toMatchObject({ status: "SUBMITTED" });
});

it("invalidates a prepared submission when another attachment changes the claim", async () => {
  const { deps, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "REQUEST_SUBMISSION" as const, reply: "请确认提交。" }) },
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: [] });
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "可以提交了吗" }, deps);

  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "补一张票据", attachment: { filename: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1]) } }, deps);

  expect(getIntake()).toMatchObject({ status: "COLLECTING", submissionToken: null, submissionPreview: null });
});

it("rolls older conversation messages into a bounded summary before model routing", async () => {
  let receivedSummary = "";
  const { deps, compareAndSetSummary } = createDeps({
    model: { decideConversation: async (context: { summary: { text: string } }) => { receivedSummary = context.summary.text; return { action: "ANSWER" as const, reply: "好的" }; } },
  });
  deps.conversations.listMessages = async () => Array.from({ length: 16 }, (_, index) => ({ sequence: index + 1, role: "USER" as const, channel: "WEB" as const, text: `历史消息 ${index + 1}` }));
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "继续办理" }, deps);

  expect(compareAndSetSummary).toHaveBeenCalledWith(expect.objectContaining({ expectedThroughSequence: 0, throughSequence: 4 }));
  expect(receivedSummary).toContain("历史消息 1");
});
