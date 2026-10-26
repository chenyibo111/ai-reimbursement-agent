import { expect, it, vi } from "vitest";

import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { ReimbursementApiHttpError } from "@/services/agent/src/adapters/reimbursement-api-client";
import type { ClaimFieldPatch } from "@/services/agent/src/ports/reimbursement-port";

it("searches twelve owned drafts in two private pages and selects only the current page ordinal", async () => {
  const setup = createDeps();
  let searchState: unknown = null;
  const setSearchState = vi.fn(async ({ state }: { state: unknown }) => { searchState = state; });
  const setSelectedReadClaimId = vi.fn(async () => undefined);
  const conversations = { ...setup.deps.conversations,
    getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, searchState }),
    setSearchState, setSelectedReadClaimId,
  };
  const claims = Array.from({ length: 12 }, (_, index) => ({ id: `claim-${index+1}`, claimNumber: `BX20261026-${String(index+1).padStart(4,"0")}`, status: "DRAFT", purpose: `出差${index+1}`, version: 1, currency: "CNY" as const, totalAmountCent: null, requestedAmountCent: null }));
  const searchOwnedClaims = vi.fn(async ({ query }: { query: { cursor?: string; limit: number } }) => ({ items: query.cursor ? claims.slice(10) : claims.slice(0, 10), totalCount: 12, nextCursor: query.cursor ? null : "next-page" }));
  const decisions = [
    { action: "SEARCH_CLAIMS" as const, reply: "查询", search: { status: "DRAFT" as const, period: "LAST_MONTH" as const, requestedCount: 12 } },
    { action: "NEXT_CLAIMS_PAGE" as const, reply: "翻页" },
    { action: "READ_CLAIM" as const, reply: "读取", claimOrdinal: 2 },
  ];
  const model = { decideConversation: vi.fn(async () => decisions.shift()!) };
  const readWorkbench = vi.fn(async () => ({ claim: claims[11], receipts: [] }));
  const deps = { ...setup.deps, conversations, model, searchOwnedClaims, readWorkbench };
  const first = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "上月草稿列 12 张" }, deps);
  expect(first.reply).toContain("共 12 张");
  expect(first.reply).toContain("BX20261026-0010");
  expect(first.reply).not.toContain("BX20261026-0011");
  expect(first.reply.length).toBeLessThanOrEqual(1000);
  const next = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "下一页" }, deps);
  expect(next.reply).toContain("BX20261026-0012");
  expect(searchOwnedClaims).toHaveBeenCalledTimes(2);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "第二张" }, deps);
  expect(readWorkbench).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "claim-12" });
  expect(setSelectedReadClaimId).toHaveBeenCalledWith({ conversationId: "conversation-1", claimId: "claim-12" });
});

it("answers an owned count from Go without exposing any claim list", async () => {
  const setup = createDeps();
  const searchOwnedClaims = vi.fn(async () => ({ items: [], totalCount: 37, nextCursor: null }));
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "上月交通费一共几张" }, {
    ...setup.deps,
    conversations: { ...setup.deps.conversations, setSearchState: vi.fn(async () => undefined) },
    model: { decideConversation: async () => ({ action: "SEARCH_CLAIMS" as const, reply: "无关", search: { period: "LAST_MONTH" as const, expenseCategory: "交通费", countOnly: true } }) },
    searchOwnedClaims,
  });
  expect(result.reply).toBe("查询时共 37 张本人报销单。");
  expect(searchOwnedClaims).toHaveBeenCalledWith(expect.objectContaining({ actorId: "employee-1", query: expect.objectContaining({ countOnly: true, limit: 1 }) }));
});

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
  const updateFields = vi.fn(async ({ fields }: { actorId: string; claimId: string; fields: ClaimFieldPatch }) => ({ id: "agent-claim-1", claimNumber: "BX20261009-0026", version: 2, status: "DRAFT", purpose: fields.purpose ?? "", expenseCategory: fields.expenseCategory ?? "", participants: fields.participants ?? [], projectCode: fields.projectCode ?? "", totalAmountCent: null, currency: "CNY" as const }));
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
      updateFields,
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
    updateFields,
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
  const searchPolicy = vi.fn(async () => ({ citations: [{ id: "citation-1", title: "制度", url: "https://example", headingPath: [], excerpt: "住宿上限 500 元", score: 0.9 }], evidence: [{ sectionId: "section-1", title: "制度", headingPath: [], text: "住宿上限 500 元", complete: true }], incomplete: false }));
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

it("does not give a definitive policy answer when chapter evidence is incomplete", async () => {
  const answerPolicy = vi.fn(async () => "北京上海上限 600 元");
  const { deps } = createDeps({
    searchPolicy: async () => ({ citations: [{ id: "c1", title: "差旅", url: "https://example", excerpt: "北京上海 600 元", headingPath: ["住宿"], score: 0.9 }], evidence: [], incomplete: true }),
    model: { decideConversation: async () => ({ action: "POLICY_QUERY" as const, reply: "" }), answerPolicy },
  });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "住宿费规则" }, deps);
  expect(result.reply).toContain("无法读取完整章节");
  expect(result.citations).toHaveLength(1);
  expect(answerPolicy).not.toHaveBeenCalled();
});

it("does not treat an in-flight redelivery of a start request as restart confirmation", async () => {
  const setup = createDeps({ model: { decideConversation: async () => ({ action: "START_INTAKE" as const, reply: "只分类" }) } });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1" });
  let inboundCount = 0;
  let enterFirstReply!: () => void;
  let releaseFirstReply!: () => void;
  const firstReplyEntered = new Promise<void>((resolve) => { enterFirstReply = resolve; });
  const firstReplyBlocked = new Promise<void>((resolve) => { releaseFirstReply = resolve; });
  let assistantCount = 0;
  const deps = {
    ...setup.deps,
    conversations: {
      ...setup.deps.conversations,
      appendUserMessageIfAbsent: async () => ({ message: { sequence: 1 }, created: ++inboundCount === 1 }),
      findAssistantReplyByInboundMessageId: async () => null,
      appendMessage: async (input: Parameters<ConversationStore["appendMessage"]>[0]) => {
        if (input.role === "ASSISTANT" && ++assistantCount === 1) {
          enterFirstReply();
          await firstReplyBlocked;
        }
        return setup.appendMessage(input);
      },
    },
  };
  const input = { actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU" as const, chatType: "p2p" as const, channelMessageId: "om-replayed-start", message: "另起一单" };
  const first = runConversationTurn(input, deps);
  await firstReplyEntered;
  try {
    await expect(runConversationTurn(input, deps)).rejects.toThrow("inbound turn is already processing");
    expect(setup.restartIntake).not.toHaveBeenCalled();
  } finally {
    releaseFirstReply();
    await first;
  }
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

it("writes fields and uploads attachments to the selected older draft without changing the active Intake", async () => {
  const setup = createDeps();
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "new-intake", collectedFields: { purpose: "新单事由" } });
  const oldClaim = { id: "older-draft", claimNumber: "BX20261026-0007", version: 3, status: "DRAFT", purpose: "旧事由", totalAmountCent: null, currency: "CNY" as const };
  const readWorkbench = vi.fn(async ({ claimId }: { claimId: string }) => ({ claim: claimId === "new-intake" ? { ...oldClaim, id: "new-intake", purpose: "新单事由" } : oldClaim, receipts: [] }));
  const updateFields = vi.fn(async ({ claimId, fields }: { claimId: string; fields: ClaimFieldPatch }) => ({ ...oldClaim, id: claimId, ...fields }));
  const deps = { ...setup.deps, readWorkbench, updateFields,
    conversations: { ...setup.deps.conversations, getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, selectedEditClaimId: "older-draft" }) },
    model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "", fields: { purpose: "旧单更新", expenseCategory: "交通", participants: ["张三"], projectCode: "P-001" } }) },
  };
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "修改事由" }, deps);
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传", attachment: { filename: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) } }, deps);
  expect(updateFields).toHaveBeenCalledWith(expect.objectContaining({ claimId: "older-draft" }));
  expect(setup.uploadReceipt).toHaveBeenCalledWith(expect.objectContaining({ claimId: "older-draft" }));
  expect(setup.getIntake()?.claimId).toBe("new-intake");
  expect(setup.getIntake()?.collectedFields.purpose).toBe("新单事由");
});

it("previews the exact second same-name receipt and deletes it once after confirmation", async () => {
  const setup = createDeps();
  let pendingAction: unknown = null;
  const receipts = ["receipt-1", "receipt-2"].map((id) => ({ id, claimId: "older-draft", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: id, ocrConfidence: 0.9, totalAmountCent: 1000 }));
  const claim = { id: "older-draft", claimNumber: "BX20261026-0007", version: 3, status: "DRAFT", purpose: "旧事由", totalAmountCent: 2000, currency: "CNY" as const };
  const deleteReceipt = vi.fn(async () => undefined);
  const deps = { ...setup.deps,
    conversations: { ...setup.deps.conversations,
      getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, selectedEditClaimId: "older-draft", pendingAction }),
      setPendingAction: vi.fn(async ({ action }: { action: unknown }) => { pendingAction = action; }),
    },
    model: { decideConversation: async () => ({ action: "DELETE_RECEIPT" as const, reply: "", receiptOrdinal: 2 }) },
    readWorkbench: vi.fn(async () => ({ claim, receipts })),
    deleteReceipt,
  };
  const preview = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "删除第二张票据" }, deps);
  expect(preview.reply).toContain("receipt-2");
  expect(deleteReceipt).not.toHaveBeenCalled();
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认删除票据" }, deps);
  expect(deleteReceipt).toHaveBeenCalledTimes(1);
  expect(deleteReceipt).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "older-draft", receiptId: "receipt-2", expectedClaimVersion: 3 });
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认删除票据" }, deps);
  expect(deleteReceipt).toHaveBeenCalledTimes(1);
});

it("edits a selected old draft even without a current Intake", async () => {
  const setup = createDeps();
  const updateFields = vi.fn(async ({ claimId, fields }: { claimId: string; fields: ClaimFieldPatch }) => ({ id: claimId, claimNumber: "BX20261026-0007", version: 4, status: "DRAFT", purpose: fields.purpose ?? null, totalAmountCent: null, currency: "CNY" as const }));
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "补事由" }, {
    ...setup.deps, updateFields,
    conversations: { ...setup.deps.conversations, getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, selectedEditClaimId: "older-draft" }) },
    readWorkbench: async () => ({ claim: { id: "older-draft", claimNumber: "BX20261026-0007", version: 3, status: "DRAFT", purpose: "", totalAmountCent: null, currency: "CNY" }, receipts: [] }),
    model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "", fields: { purpose: "已补" } }) },
  });
  expect(result.reply).toContain("BX20261026-0007");
  expect(updateFields).toHaveBeenCalledTimes(1);
  expect(setup.createIntake).not.toHaveBeenCalled();
});

it("does not upload to the Intake when only a different claim was read", async () => {
  const setup = createDeps();
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "new-intake" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "上传发票", attachment: { filename: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) } }, {
    ...setup.deps,
    conversations: { ...setup.deps.conversations, getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, selectedReadClaimId: "older-draft" }) },
  });
  expect(result.reply).toContain("请先明确选择");
  expect(setup.uploadReceipt).not.toHaveBeenCalled();
  expect(setup.getIntake()?.claimId).toBe("new-intake");
});

it("rejects a receipt deletion confirmation after the claim version changes", async () => {
  const setup = createDeps();
  const deleteReceipt = vi.fn(async () => undefined);
  const action = { kind: "DELETE_RECEIPT", claimId: "older-draft", claimVersion: 3, receiptId: "receipt-2", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const setPendingAction = vi.fn(async () => undefined);
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认删除票据" }, {
    ...setup.deps, deleteReceipt,
    conversations: { ...setup.deps.conversations, getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, pendingAction: action }), setPendingAction },
    readWorkbench: async () => ({ claim: { id: "older-draft", claimNumber: "BX20261026-0007", version: 4, status: "DRAFT", purpose: "", totalAmountCent: null, currency: "CNY" }, receipts: [{ id: "receipt-2", claimId: "older-draft", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "2", ocrConfidence: 0.9, totalAmountCent: 1000 }] }),
  });
  expect(result.reply).toContain("已失效");
  expect(deleteReceipt).not.toHaveBeenCalled();
  expect(setPendingAction).toHaveBeenCalledWith({ conversationId: "conversation-1", action: null });
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

  expect(createClaim).toHaveBeenCalledWith({ actorId: "employee-1" });
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
  const { deps, updateFields, getIntake } = createDeps({
    model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "已记录事由。", fields: { purpose: "客户拜访" } }) },
  });
  await deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", pendingFields: ["purpose"] });

  await expect(runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "用于客户拜访" }, deps)).resolves.toMatchObject({
    intake: { collectedFields: { purpose: "客户拜访" } },
  });

  expect(updateFields).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1", fields: { purpose: "客户拜访" } });
  expect(getIntake()).toMatchObject({ collectedFields: { purpose: "客户拜访" } });
});

it("creates a Go draft for the first fields and acknowledges only verified readback", async () => {
  const fields = { purpose: "客户拜访", expenseCategory: "交通", participants: ["张三"], projectCode: "P-001" };
  const setup = createDeps({ model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "ignored", fields }) } });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "补充字段" }, setup.deps);
  expect(setup.createClaim).toHaveBeenCalledOnce();
  expect(setup.updateFields).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1", fields });
  expect(result.reply).toContain("已保存");
  expect(result.intake?.collectedFields).toEqual(fields);
});

it("does not acknowledge an unverified write or retain an old confirmation", async () => {
  const setup = createDeps({ model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "ignored", fields: { purpose: "新事由" } }) }, updateFields: async () => ({ id: "agent-claim-1", version: 3, purpose: "旧事由" }) });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", status: "READY_TO_SUBMIT", submissionToken: "old-token" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "修改事由" }, setup.deps);
  expect(result.reply).not.toContain("已保存");
  expect(result.intake?.submissionToken).toBeNull();
  expect(result.intake?.collectedFields).not.toHaveProperty("purpose", "新事由");
});

it("warns and removes legacy Intake-only fields instead of presenting them as saved", async () => {
  const readWorkbench = vi.fn(async () => ({ claim: { id: "agent-claim-1", claimNumber: "BX20261009-0026", version: 2, status: "DRAFT", purpose: "客户拜访", expenseCategory: "", participants: [], projectCode: "", totalAmountCent: null, currency: "CNY" as const }, receipts: [] }));
  const setup = createDeps({ readWorkbench, model: { decideConversation: async () => ({ action: "READ_CLAIM" as const, reply: "ignored" }) } });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1", collectedFields: { purpose: "客户拜访", expenseCategory: "交通", participants: ["张三"] }, pendingFields: [] });

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "这单信息是什么" }, setup.deps);

  expect(result.reply).toContain("费用类别、参与人员");
  expect(result.reply).toContain("未保存");
  expect(result.intake?.collectedFields).toEqual({ purpose: "客户拜访" });
  expect(setup.updateFields).not.toHaveBeenCalled();
  expect(readWorkbench).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "agent-claim-1" });
  const next = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "现在这单信息是什么" }, setup.deps);
  expect(next.reply).toContain("BX20261009-0026");
  expect(next.reply).not.toContain("旧会话中的");
});

it("rejects an amount proposal before creating a draft", async () => {
  const setup = createDeps({ model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "saved", fields: { requestedAmountCent: 10000 } }) } });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "金额一百" }, setup.deps);
  expect(result.reply).toContain("Web 工作台");
  expect(setup.createClaim).not.toHaveBeenCalled();
  expect(setup.updateFields).not.toHaveBeenCalled();
});

it("does not overwrite a concurrent Web edit after a Go version conflict", async () => {
  const setup = createDeps({ model: { decideConversation: async () => ({ action: "COLLECT_FIELDS" as const, reply: "saved", fields: { purpose: "新事由" } }) }, updateFields: async () => { throw new ReimbursementApiHttpError("changed", 409, "VERSION_CONFLICT"); } });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "agent-claim-1" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "改事由" }, setup.deps);
  expect(result.reply).not.toContain("已保存");
  expect(result.intake?.collectedFields).toEqual({});
});

it("lists at most five owner claims without creating an Intake", async () => {
  const listOwnedClaims = vi.fn(async () => Array.from({ length: 7 }, (_, index) => ({ id: `claim-${index}`, claimNumber: `BX20261009-${String(index + 1).padStart(4, "0")}`, status: "DRAFT", purpose: "客户拜访" })));
  const setup = createDeps({ listOwnedClaims, model: { decideConversation: async () => ({ action: "LIST_CLAIMS" as const, reply: "ignored" }) } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "我有哪些报销单" }, setup.deps);
  expect(result.reply).toContain("BX20261009-0001");
  expect(result.reply).not.toContain("BX20261009-0007");
  expect(setup.createClaim).not.toHaveBeenCalled();
});

it("keeps a read-only claim separate and refuses an ambiguous write or submission", async () => {
  let selectedReadClaimId: string | null = null;
  let turns = 0;
  const readWorkbench = vi.fn(async ({ claimId }: { claimId: string }) => ({ claim: { id: claimId, claimNumber: "BX20261009-0026", version: 2, status: claimId === "old-claim" ? "SUBMITTED" : "DRAFT", purpose: claimId === "old-claim" ? "旧事由" : "新事由", requestedAmountCent: 10000, totalAmountCent: 10000, currency: "CNY" as const }, receipts: [] }));
  const setup = createDeps({
    model: { decideConversation: async () => {
      ++turns;
      return turns <= 2
        ? { action: "READ_CLAIM" as const, reply: "ignored", ...(turns === 1 ? { claimNumber: "BX20261009-0026" } : {}) }
        : turns === 3
          ? { action: "COLLECT_FIELDS" as const, reply: "ignored", fields: { purpose: "新事由" } }
          : { action: "PREPARE_SUBMISSION" as const, reply: "ignored" };
    } },
    findOwnedClaimByNumber: async () => ({ id: "old-claim", claimNumber: "BX20261009-0026", status: "SUBMITTED", purpose: "旧事由", version: 2, currency: "CNY", totalAmountCent: 10000 }),
    readWorkbench,
  });
  setup.deps.conversations = { ...setup.deps.conversations,
    getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, selectedReadClaimId }),
    setSelectedReadClaimId: async ({ claimId }: { conversationId: string; claimId: string | null }) => { selectedReadClaimId = claimId; },
  } as never;
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "active-claim" });
  const read = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "查 BX20261009-0026" }, setup.deps);
  expect(read.reply).toContain("BX20261009-0026");
  expect(readWorkbench).toHaveBeenCalledWith({ actorId: "employee-1", claimId: "old-claim" });
  expect(selectedReadClaimId).toBe("old-claim");
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "这单金额" }, setup.deps);
  expect(readWorkbench).toHaveBeenCalledTimes(2);
  expect(readWorkbench).toHaveBeenLastCalledWith({ actorId: "employee-1", claimId: "old-claim" });
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "改事由" }, setup.deps);
  expect(setup.updateFields).not.toHaveBeenCalled();
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "准备提交" }, setup.deps);
  expect(setup.prepareSubmission).not.toHaveBeenCalled();
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, setup.deps);
  expect(setup.submitClaim).not.toHaveBeenCalled();
});

it("selects an explicit owned draft as an edit target without replacing an active Intake", async () => {
  const setup = createDeps({
    model: { decideConversation: async () => ({ action: "SELECT_EDIT_CLAIM" as const, reply: "ignored", claimNumber: "BX20261026-0007" }) },
    findOwnedClaimByNumber: async () => ({ id: "older-draft", claimNumber: "BX20261026-0007", status: "DRAFT", purpose: "旧差旅", version: 3, currency: "CNY", totalAmountCent: null }),
    readWorkbench: async () => ({ claim: { id: "older-draft", claimNumber: "BX20261026-0007", status: "DRAFT", purpose: "旧差旅", version: 3, currency: "CNY", totalAmountCent: null }, receipts: [] }),
  });
  const setSelectedEditClaimId = vi.fn(async () => undefined);
  setup.deps.conversations = { ...setup.deps.conversations, setSelectedEditClaimId } as never;
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "current-draft" });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "编辑 BX20261026-0007" }, setup.deps);
  expect(result.reply).toContain("BX20261026-0007");
  expect(setSelectedEditClaimId).toHaveBeenCalledWith({ conversationId: "conversation-1", claimId: "older-draft" });
  expect(setup.getIntake()?.claimId).toBe("current-draft");
});

it("invalidates an old Intake submission confirmation when edit target changes", async () => {
  const setup = createDeps({
    model: { decideConversation: async () => ({ action: "SELECT_EDIT_CLAIM" as const, reply: "ignored", claimNumber: "BX20261026-0007" }) },
    findOwnedClaimByNumber: async () => ({ id: "older-draft", claimNumber: "BX20261026-0007", status: "DRAFT", purpose: "旧差旅", version: 3, currency: "CNY", totalAmountCent: null }),
    readWorkbench: async () => ({ claim: { id: "older-draft", claimNumber: "BX20261026-0007", status: "DRAFT", purpose: "旧差旅", version: 3, currency: "CNY", totalAmountCent: null }, receipts: [] }),
  });
  setup.deps.conversations = { ...setup.deps.conversations, setSelectedEditClaimId: vi.fn(async () => undefined) } as never;
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "current-draft", status: "READY_TO_SUBMIT", submissionToken: "old-token" });
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "编辑 BX20261026-0007" }, setup.deps);
  expect(setup.getIntake()?.submissionToken).toBeNull();
  await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "确认提交" }, setup.deps);
  expect(setup.submitClaim).not.toHaveBeenCalled();
});

it("cannot select a submitted or inaccessible claim for editing", async () => {
  for (const found of [null, { id: "submitted", claimNumber: "BX20261026-0007", status: "SUBMITTED", purpose: "旧单", version: 2, currency: "CNY", totalAmountCent: null }]) {
    const setup = createDeps({ model: { decideConversation: async () => ({ action: "SELECT_EDIT_CLAIM" as const, reply: "ignored", claimNumber: "BX20261026-0007" }) }, findOwnedClaimByNumber: async () => found });
    const setSelectedEditClaimId = vi.fn(async () => undefined);
    setup.deps.conversations = { ...setup.deps.conversations, setSelectedEditClaimId } as never;
    const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "编辑 BX20261026-0007" }, setup.deps);
    expect(result.reply).not.toContain("已选中");
    expect(setSelectedEditClaimId).not.toHaveBeenCalledWith(expect.objectContaining({ claimId: "submitted" }));
  }
});

it("gives the same safe reply for a missing or foreign business number", async () => {
  const setup = createDeps({ findOwnedClaimByNumber: async () => null, readWorkbench: async () => { throw new Error("must not read"); }, model: { decideConversation: async () => ({ action: "READ_CLAIM" as const, reply: "ignored", claimNumber: "BX20261009-0026" }) } });
  const setSelectedReadClaimId = vi.fn(async () => undefined);
  setup.deps.conversations = { ...setup.deps.conversations,
    getConversationByIdOrThrow: async () => ({ id: "conversation-1", summary: "", summaryThroughSequence: 0, selectedReadClaimId: "previous-claim" }),
    setSelectedReadClaimId,
  } as never;
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "WEB", message: "查询 BX20261009-0026" }, setup.deps);
  expect(result.reply).toBe("未找到该报销单，或你无权访问。请核对单号。");
  expect(setSelectedReadClaimId).toHaveBeenCalledWith({ conversationId: "conversation-1", claimId: null });
});

it("does not list private claims in a Feishu group", async () => {
  const listOwnedClaims = vi.fn(async () => []);
  const setup = createDeps({ listOwnedClaims, model: { decideConversation: async () => ({ action: "LIST_CLAIMS" as const, reply: "ignored" }) } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "group", message: "我的报销单" }, setup.deps);
  expect(result.reply).toContain("私聊");
  expect(listOwnedClaims).not.toHaveBeenCalled();
});

it("does not reveal stale private Intake fields in a Feishu group", async () => {
  const readWorkbench = vi.fn(async () => ({ claim: { id: "claim-1" }, receipts: [] }));
  const decideConversation = vi.fn(async () => ({ action: "READ_CLAIM" as const, reply: "ignored" }));
  const setup = createDeps({ readWorkbench, model: { decideConversation } });
  await setup.deps.conversations.createIntake({ employeeId: "employee-1", conversationId: "conversation-1", claimId: "claim-1", collectedFields: { purpose: "私密客户拜访" } });
  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "group", message: "看看当前报销单" }, setup.deps);
  expect(result.reply).toContain("私聊");
  expect(result.reply).not.toContain("报销事由");
  expect(readWorkbench).not.toHaveBeenCalled();
  expect(decideConversation).toHaveBeenCalledWith(expect.objectContaining({ intake: null }));
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

it("lists the supported Feishu private-chat abilities without promising direct amount edits", async () => {
  const { deps } = createDeps({ model: { decideConversation: async () => ({ action: "HELP" as const, reply: "我能自动填写金额并提交任何单据" }) } });

  const result = await runConversationTurn({ actorId: "employee-1", conversationId: "conversation-1", channel: "FEISHU", chatType: "p2p", message: "你有哪些能力" }, deps);

  for (const capability of ["报销政策", "上传票据", "识别结果", "报销事由", "费用类别", "参与人员", "项目编号", "最近 5 张", "完整单号", "单据状态", "申请报销总额", "票据金额", "提交条件", "提交前摘要", "确认提交"]) {
    expect(result.reply).toContain(capability);
  }
  expect(result.reply).toContain("金额、币种和备注请到 Web 工作台填写");
  expect(result.reply).toContain("飞书私聊");
  expect(result.reply).not.toContain("自动填写金额");
  expect(result.reply).not.toContain("提交任何单据");
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
