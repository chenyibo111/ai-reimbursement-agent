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
};

function createDeps(overrides: Partial<Record<string, unknown>> = {}) {
  let intake: Intake | null = null;
  const appendMessage = vi.fn(async (input: { text: string }) => ({ id: "message-1", sequence: 1, ...input }));
  const conversations = {
    getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0 }),
    listMessages: async () => [],
    appendMessage,
    getCurrentIntake: async () => intake,
    createIntake: async ({ employeeId, conversationId, ...patch }: Pick<Intake, "employeeId" | "conversationId"> & Partial<Intake>) => {
      intake = { id: "intake-1", employeeId, conversationId, status: "COLLECTING", claimId: null, collectedFields: {}, pendingFields: ["purpose"], submissionToken: null, ...patch };
      return intake;
    },
    updateIntake: async (input: Partial<Intake> & { id: string }) => {
      if (!intake) throw new Error("missing intake");
      intake = { ...intake, ...input };
      return intake;
    },
  };
  const createClaim = vi.fn(async () => ({ id: "agent-claim-1", version: 1 }));
  const uploadReceipt = vi.fn(async () => ({ id: "receipt-1" }));
  const updatePurpose = vi.fn(async () => ({ version: 2 }));
  const requestSubmission = vi.fn(async () => ({ token: "confirmation-token", claimId: "agent-claim-1" }));
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

it("creates an Intake only for an explicit start command and persists an assistant reply", async () => {
  const { deps, createClaim, getIntake, appendMessage } = createDeps();

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "开始报销" }, deps);

  expect(result).toMatchObject({ intake: { id: "intake-1", status: "COLLECTING" } });
  expect(createClaim).not.toHaveBeenCalled();
  expect(getIntake()).toMatchObject({ pendingFields: ["purpose"] });
  expect(appendMessage).toHaveBeenCalledTimes(2);
});

it("does not expose or replace an Intake that belongs to another conversation", async () => {
  const { deps, createClaim, uploadReceipt } = createDeps();
  const foreign = { id: "intake-private", employeeId: "employee-1", conversationId: "private-conversation", status: "COLLECTING" as const, claimId: "claim-private", collectedFields: {}, pendingFields: ["purpose"], submissionToken: null };
  deps.conversations.getCurrentIntake = async () => foreign;
  deps.conversations.createIntake = async () => { throw new Error("active intake exists"); };

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
    intake: { status: "READY_TO_SUBMIT" },
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
