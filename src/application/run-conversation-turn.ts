import { buildConversationContext, type ConversationContext } from "@/src/application/build-conversation-context";
import type { AgentMessageChannel, AgentMessageRole, ReimbursementIntakeStatus } from "@/src/domain/agent-conversation";
import type { ConversationDecision, ChatModel } from "@/src/infrastructure/model/chat-model";
import type { PolicyCitation } from "@/src/application/search-policy-knowledge";
import { formatClaimFacts, type ClaimFactKind } from "@/src/application/format-claim-facts";
import type { ClaimSnapshot, ReceiptSnapshot, ValidationSnapshot } from "@/services/agent/src/ports/reimbursement-port";
import { ReimbursementApiHttpError } from "@/services/agent/src/adapters/reimbursement-api-client";

type ConversationRecord = { id: string; summary: string; summaryThroughSequence: number };
type ConversationMessage = { id?: string; sequence: number; role: AgentMessageRole; channel: AgentMessageChannel; text: string; citations?: unknown; result?: unknown };
type IntakeRecord = {
  id: string;
  employeeId: string;
  conversationId: string;
  status: ReimbursementIntakeStatus;
  claimId: string | null;
  collectedFields: Record<string, unknown>;
  pendingFields: string[];
  submissionToken: string | null;
  submissionPreview?: Record<string, unknown> | null;
};

export type ConversationStore = {
  getConversationByIdOrThrow(id: string): Promise<ConversationRecord>;
  listMessages(input: { conversationId: string; limit?: number }): Promise<ConversationMessage[]>;
  appendMessage(input: { conversationId: string; role: AgentMessageRole; channel: AgentMessageChannel; channelMessageId?: string | null; inReplyToChannelMessageId?: string | null; text: string; citations?: Record<string, unknown>[]; result?: Record<string, unknown> }): Promise<unknown>;
  appendUserMessageIfAbsent?(input: { conversationId: string; role: "USER"; channel: AgentMessageChannel; channelMessageId: string; text: string }): Promise<{ message: { sequence: number }; created: boolean }>;
  findAssistantReplyByInboundMessageId?(channelMessageId: string): Promise<ConversationMessage | null>;
  compareAndSetSummary?(input: { conversationId: string; expectedThroughSequence: number; summary: string; throughSequence: number }): Promise<boolean>;
  getCurrentIntake(employeeId: string): Promise<IntakeRecord | null>;
  createIntake(input: { employeeId: string; conversationId: string; claimId?: string | null; collectedFields?: Record<string, unknown>; pendingFields?: string[]; submissionToken?: string | null; submissionPreview?: Record<string, unknown> | null }): Promise<IntakeRecord>;
  updateIntake(input: { id: string; status?: ReimbursementIntakeStatus; claimId?: string | null; collectedFields?: Record<string, unknown>; pendingFields?: string[]; submissionToken?: string | null; submissionPreview?: Record<string, unknown> | null; lastUserConfirmationAt?: Date | null }): Promise<IntakeRecord>;
};

export type RunConversationTurnDeps = {
  conversations: ConversationStore;
  model: Pick<ChatModel, "classifyIntent" | "answerPolicy" | "decideConversation">;
  searchPolicy?: (query: string) => Promise<PolicyCitation[]>;
  createClaim?: (input: { actorId: string; purpose?: string }) => Promise<{ id: string; version: number }>;
  preflightAttachment?: (input: { filename: string; mimeType: string; bytes: Uint8Array }) => Promise<void>;
  uploadReceipt?: (input: { actorId: string; claimId: string; filename: string; mimeType: string; bytes: Uint8Array; notificationTarget?: { conversationId: string; chatId: string } }) => Promise<{ id: string; jobId?: string }>;
  extractReceipt?: (input: { actorId: string; claimId: string; receiptId: string }) => Promise<unknown>;
  updatePurpose?: (input: { actorId: string; claimId: string; value: string }) => Promise<{ version: number }>;
  readWorkbench?: (input: { actorId: string; claimId: string }) => Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>;
  readValidation?: (input: { actorId: string; claimId: string }) => Promise<ValidationSnapshot>;
  prepareSubmission?: (input: { actorId: string; claimId: string }) => Promise<{ token: string; claimId: string; claimVersion: number; workbench: { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] } }>;
  submitClaim?: (input: { actorId: string; claimId: string; confirmationToken: string }) => Promise<{ submissionNumber: string }>;
};

export type ConversationTurnResult = {
  reply: string;
  citations: PolicyCitation[];
  intake: IntakeRecord | null;
  submissionNumber?: string;
};

export async function runConversationTurn(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; chatType?: "p2p" | "group"; chatId?: string; channelMessageId?: string; message: string; attachment?: { filename: string; mimeType: string; bytes: Uint8Array } },
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  const message = normalizeMessage(input.message);
  const conversation = await deps.conversations.getConversationByIdOrThrow(input.conversationId);
  if (input.channelMessageId && deps.conversations.appendUserMessageIfAbsent) {
    const appended = await deps.conversations.appendUserMessageIfAbsent({ conversationId: conversation.id, role: "USER", channel: input.channel, channelMessageId: input.channelMessageId, text: message });
    if (!appended.created) {
      const persisted = await deps.conversations.findAssistantReplyByInboundMessageId?.(input.channelMessageId);
      if (persisted) return replayPersistedTurn(persisted);
    }
  } else {
    await deps.conversations.appendMessage({ conversationId: conversation.id, role: "USER", channel: input.channel, channelMessageId: input.channelMessageId, text: message });
  }
  const active = await getConversationIntake(input.actorId, conversation.id, deps.conversations);

  const attachment = input.attachment;
  if (attachment) return handleAttachment({ ...input, attachment }, active, deps);
  if (message === "确认提交" && input.channel === "FEISHU" && input.chatType !== "p2p") {
    return persistReply(input, null, "为保护报销信息，请私聊机器人或在 Web 工作台发起并确认提交。", [], deps.conversations);
  }
  if (message === "确认提交") return confirmSubmission(input, active, deps);
  if (message === "开始报销") return startIntake(input, active, deps);

  if (await isPolicyQuestion(message, deps)) {
    return answerPolicyQuestion(input, active, message, deps);
  }

  const context = await getContext(conversation, active, deps.conversations, deps.searchPolicy, message);
  const decision: ConversationDecision = deps.model.decideConversation
    ? await deps.model.decideConversation(context)
    : { action: "HELP", reply: "我暂时无法处理这条报销办理请求，请在工作台继续填写。" };
  return applyDecision(input, active, decision, deps);
}

async function handleAttachment(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; chatId?: string; channelMessageId?: string; attachment: { filename: string; mimeType: string; bytes: Uint8Array } },
  active: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (!deps.createClaim || !deps.preflightAttachment || !deps.uploadReceipt) throw new Error("attachment handling is unavailable");
  await deps.preflightAttachment(input.attachment);
  let intake = active;
  if (!intake) {
    try {
      intake = await deps.conversations.createIntake({ employeeId: input.actorId, conversationId: input.conversationId, pendingFields: ["purpose"] });
    } catch (error) {
      if (error instanceof Error && error.message === "active intake exists") {
        return persistReply(input, null, "你在另一会话已有一项进行中的报销办理，请回到原会话继续。", [], deps.conversations);
      }
      throw error;
    }
  }
  if (!intake.claimId) {
    const purpose = asPurpose(intake.collectedFields.purpose);
    const claim = await deps.createClaim({ actorId: input.actorId, ...(purpose ? { purpose } : {}) });
    intake = await deps.conversations.updateIntake({ id: intake.id, claimId: claim.id });
  }
  if (intake.status === "READY_TO_SUBMIT") {
    intake = await deps.conversations.updateIntake({ id: intake.id, status: "COLLECTING", submissionToken: null, submissionPreview: null });
  }
  await deps.uploadReceipt({
    actorId: input.actorId,
    claimId: intake.claimId!,
    ...input.attachment,
    ...(input.channel === "FEISHU" && input.chatId ? { notificationTarget: { conversationId: input.conversationId, chatId: input.chatId } } : {}),
  });
  return persistReply(input, intake, "票据已上传并进入识别流程。请继续补充本次报销事由。", [], deps.conversations);
}

async function startIntake(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; channelMessageId?: string },
  active: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (active) {
    await deps.conversations.updateIntake({ id: active.id, status: "ABANDONED", submissionToken: null, submissionPreview: null });
  }
  let intake: IntakeRecord;
  try {
    intake = await deps.conversations.createIntake({
      employeeId: input.actorId,
      conversationId: input.conversationId,
      pendingFields: ["purpose"],
    });
  } catch (error) {
    if (error instanceof Error && error.message === "active intake exists") {
      return persistReply(input, null, "你在另一会话已有一项进行中的报销办理，请回到原会话继续。", [], deps.conversations);
    }
    throw error;
  }
  return persistReply(input, intake, "已开始新的报销办理。请上传票据，或先告诉我本次报销事由。", [], deps.conversations);
}

async function answerPolicyQuestion(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; channelMessageId?: string },
  intake: IntakeRecord | null,
  message: string,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  try {
    const citations = await deps.searchPolicy?.(message) ?? [];
    const reply = !citations.length
      ? "当前没有可供引用的已同步报销政策，请以公司财务制度为准。"
      : await answerFromCitations(message, citations, deps.model);
    return persistReply(input, intake, reply, citations, deps.conversations);
  } catch {
    return persistReply(input, intake, "政策检索暂不可用，请稍后重试或查阅公司财务制度。", [], deps.conversations);
  }
}

async function applyDecision(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; chatType?: "p2p" | "group"; channelMessageId?: string },
  intake: IntakeRecord | null,
  decision: ConversationDecision,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (input.channel === "FEISHU" && input.chatType !== "p2p" && ["READ_CLAIM", "READ_RECEIPT_AMOUNT", "READ_SUBMISSION_SUMMARY", "PREPARE_SUBMISSION"].includes(decision.action)) {
    return persistReply(input, null, "为保护报销信息，请私聊机器人或在 Web 工作台查询金额、查看摘要与提交。", [], deps.conversations);
  }
  if (decision.action === "READ_CLAIM" || decision.action === "READ_RECEIPT_AMOUNT" || decision.action === "READ_SUBMISSION_SUMMARY") {
    if (!intake?.claimId) return persistReply(input, intake, "当前会话没有绑定报销单。请先输入“开始报销”并上传票据，或在 Web 工作台查看已有单据。", [], deps.conversations);
    if (!deps.readWorkbench || (decision.action === "READ_SUBMISSION_SUMMARY" && !deps.readValidation)) return persistReply(input, intake, "报销数据暂时无法查询，请稍后重试。", [], deps.conversations);
    try {
      const workbench = await deps.readWorkbench({ actorId: input.actorId, claimId: intake.claimId });
      const validation = decision.action === "READ_SUBMISSION_SUMMARY" ? await deps.readValidation!({ actorId: input.actorId, claimId: intake.claimId }) : undefined;
      return persistReply(input, intake, formatClaimFacts(decision.action as ClaimFactKind, workbench, validation), [], deps.conversations);
    } catch (error) {
      return persistReply(input, intake, claimReadErrorReply(error), [], deps.conversations);
    }
  }
  if (decision.action === "COLLECT_FIELDS") {
    if (!intake) return persistReply(input, null, "请先输入“开始报销”或上传票据，再补充报销信息。", [], deps.conversations);
    const collectedFields = { ...intake.collectedFields, ...(decision.fields ?? {}) };
    if (intake.claimId && typeof decision.fields?.purpose === "string" && deps.updatePurpose) {
      await deps.updatePurpose({ actorId: input.actorId, claimId: intake.claimId, value: decision.fields.purpose });
    }
    const pendingFields = intake.pendingFields.filter((field) => !(field in (decision.fields ?? {})));
    const invalidatesSubmission = intake.status === "READY_TO_SUBMIT" && typeof decision.fields?.purpose === "string";
    const updated = await deps.conversations.updateIntake({
      id: intake.id,
      collectedFields,
      pendingFields,
      ...(invalidatesSubmission ? { status: "COLLECTING" as const, submissionToken: null, submissionPreview: null } : {}),
    });
    const fieldLabels: Record<string, string> = { purpose: "报销事由", expenseCategory: "费用类别", participants: "参与人员", projectCode: "项目编号" };
    const saved = Object.entries(decision.fields ?? {}).map(([name, value]) => `${fieldLabels[name] ?? name}：${value}`);
    return persistReply(input, updated, saved.length ? `已记录${saved.join("；")}。` : "没有可记录的字段，请说明要补充的报销信息。", [], deps.conversations);
  }

  if (decision.action === "PREPARE_SUBMISSION") {
    if (!intake?.claimId) return persistReply(input, intake, "当前会话没有绑定报销单，请先输入“开始报销”并上传票据。", [], deps.conversations);
    if (!deps.readValidation || !deps.prepareSubmission) return persistReply(input, intake, "报销服务暂时无法准备提交，请稍后重试。", [], deps.conversations);
    let validation: ValidationSnapshot;
    try {
      validation = await deps.readValidation({ actorId: input.actorId, claimId: intake.claimId });
    } catch (error) {
      return persistReply(input, intake, submissionErrorReply(error), [], deps.conversations);
    }
    const blocking = validation.issues.filter((issue) => issue.severity === "BLOCKING");
    if (blocking.length) {
      const cleared = await clearSubmissionPreparation(intake, deps.conversations);
      return persistReply(input, cleared, `当前报销单暂时不能提交：${blocking.map((issue) => issue.message).join("；")}。请在工作台补齐后重新发起提交。`, [], deps.conversations);
    }
    let prepared: Awaited<ReturnType<NonNullable<RunConversationTurnDeps["prepareSubmission"]>>>;
    try {
      prepared = await deps.prepareSubmission({ actorId: input.actorId, claimId: intake.claimId });
    } catch (error) {
      const cleared = await clearSubmissionPreparation(intake, deps.conversations);
      return persistReply(input, cleared, submissionErrorReply(error), [], deps.conversations);
    }
    const { claim, receipts } = prepared.workbench;
    const submissionPreview = {
      claimVersion: prepared.claimVersion,
      totalAmountCents: claim.requestedAmountCent ?? null,
      receiptCount: receipts.length,
      purpose: claim.purpose,
    };
    const updated = await deps.conversations.updateIntake({ id: intake.id, status: "READY_TO_SUBMIT", submissionToken: prepared.token, submissionPreview });
    const amount = typeof claim.requestedAmountCent === "number" ? `¥${(claim.requestedAmountCent / 100).toFixed(2)}` : "未填写";
    const reply = `提交前请核对：报销事由 ${claim.purpose || "未填写"}；申请金额 ${amount}；票据 ${receipts.length} 张。确认无误后回复“确认提交”。`;
    return persistReply(input, updated, reply, [], deps.conversations);
  }

  return persistReply(input, intake, "如需查询当前报销单或票据金额，请明确提出查询；如需继续办理，请在报销工作台查看和填写。", [], deps.conversations);
}

async function confirmSubmission(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; channelMessageId?: string },
  intake: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (!intake || intake.status !== "READY_TO_SUBMIT" || !intake.claimId || !intake.submissionToken || !deps.submitClaim) {
    return persistReply(input, intake, "当前没有有效的提交确认。请先发起提交并核对最新信息，再回复“确认提交”。", [], deps.conversations);
  }
  let submitted: { submissionNumber: string };
  try {
    submitted = await deps.submitClaim({ actorId: input.actorId, claimId: intake.claimId, confirmationToken: intake.submissionToken });
  } catch (error) {
    const cleared = await clearSubmissionPreparation(intake, deps.conversations);
    return persistReply(input, cleared, submissionErrorReply(error), [], deps.conversations);
  }
  const updated = await deps.conversations.updateIntake({ id: intake.id, status: "SUBMITTED", lastUserConfirmationAt: new Date() });
  return persistReply(input, updated, `报销单已提交，提交编号：${submitted.submissionNumber}。`, [], deps.conversations, submitted.submissionNumber);
}

async function clearSubmissionPreparation(intake: IntakeRecord, conversations: ConversationStore): Promise<IntakeRecord> {
  if (intake.status !== "READY_TO_SUBMIT" && !intake.submissionToken) return intake;
  return conversations.updateIntake({ id: intake.id, status: "COLLECTING", submissionToken: null, submissionPreview: null });
}

function submissionErrorReply(error: unknown): string {
  if (error instanceof ReimbursementApiHttpError) {
    if (error.code === "VERSION_CONFLICT") return "单据已变化，原确认不再有效。请重新发起提交并核对最新信息。";
    if (error.code === "CONFIRMATION_EXPIRED") return "提交确认已过期，请重新发起提交并核对最新信息。";
    if (error.code === "VALIDATION_BLOCKED") return "当前报销单暂时不能提交，请在工作台查看并补齐提交条件后重试。";
    if (error.code === "NOT_FOUND" || error.status === 401 || error.status === 403 || error.status === 404) return "无法访问当前报销单，请确认登录身份和工作台中的单据。";
  }
  return "报销服务暂时无法确认操作结果，请先在工作台核对单据状态，稍后重新发起提交。";
}

function claimReadErrorReply(error: unknown): string {
  if (error instanceof ReimbursementApiHttpError && (error.code === "NOT_FOUND" || error.status === 401 || error.status === 403 || error.status === 404)) {
    return "无法访问当前报销单，请确认登录身份和工作台中的单据。";
  }
  return "报销数据暂时无法查询，请稍后重试。";
}

async function getContext(
  conversation: ConversationRecord,
  intake: IntakeRecord | null,
  conversations: ConversationStore,
  searchPolicy: RunConversationTurnDeps["searchPolicy"],
  message: string,
): Promise<ConversationContext> {
  const [messages, citations] = await Promise.all([
    conversations.listMessages({ conversationId: conversation.id, limit: 200 }),
    searchPolicy ? searchPolicy(message).catch(() => []) : Promise.resolve([]),
  ]);
  const summarizedConversation = await summarizeOlderMessages(conversation, messages, conversations);
  return buildConversationContext({
    conversation: summarizedConversation,
    messages,
    intake,
    policyCitations: citations,
  });
}

async function summarizeOlderMessages(
  conversation: ConversationRecord,
  messages: ConversationMessage[],
  conversations: ConversationStore,
): Promise<ConversationRecord> {
  const keepRecent = 12;
  if (!conversations.compareAndSetSummary || messages.length <= keepRecent) return conversation;
  const olderMessages = messages.slice(0, -keepRecent).filter((item) => item.sequence > conversation.summaryThroughSequence);
  const throughSequence = olderMessages.at(-1)?.sequence;
  if (!throughSequence) return conversation;
  const additions = olderMessages.map((item) => `${item.role === "USER" ? "员工" : "助理"}：${item.text.trim().slice(0, 600)}`).filter(Boolean);
  const summary = [conversation.summary, ...additions].filter(Boolean).join("\n").slice(-6_000);
  const updated = await conversations.compareAndSetSummary({
    conversationId: conversation.id,
    expectedThroughSequence: conversation.summaryThroughSequence,
    summary,
    throughSequence,
  });
  return updated ? { ...conversation, summary, summaryThroughSequence: throughSequence } : conversation;
}

async function getConversationIntake(employeeId: string, conversationId: string, conversations: ConversationStore): Promise<IntakeRecord | null> {
  const intake = await conversations.getCurrentIntake(employeeId);
  return intake?.conversationId === conversationId ? intake : null;
}

async function isPolicyQuestion(message: string, deps: RunConversationTurnDeps): Promise<boolean> {
  if (/政策|制度|标准|报销规定|报销规则/.test(message)) return true;
  try {
    return await deps.model.classifyIntent?.(message) === "POLICY_QUERY";
  } catch {
    return false;
  }
}

async function answerFromCitations(message: string, citations: PolicyCitation[], model: RunConversationTurnDeps["model"]): Promise<string> {
  try {
    const reply = await model.answerPolicy?.({ question: message, sources: citations.map(({ title, excerpt, headingPath }) => ({ title, excerpt, headingPath })) });
    if (reply?.trim()) return reply.trim().slice(0, 1_000);
  } catch {
    // The evidence remains useful even when the answer model is unavailable.
  }
  return "已找到相关制度依据，请以引用章节为准。";
}

async function persistReply(
  input: { conversationId: string; channel: AgentMessageChannel; channelMessageId?: string },
  intake: IntakeRecord | null,
  reply: string,
  citations: PolicyCitation[],
  conversations: ConversationStore,
  submissionNumber?: string,
): Promise<ConversationTurnResult> {
  await conversations.appendMessage({
    conversationId: input.conversationId,
    role: "ASSISTANT",
    channel: input.channel,
    inReplyToChannelMessageId: input.channelMessageId,
    text: reply,
    citations: citations.map(({ id, title, url, excerpt, headingPath, score }) => ({ id, title, url, excerpt, headingPath, score })),
    result: { intakeId: intake?.id ?? null, claimId: intake?.claimId ?? null, submissionNumber: submissionNumber ?? null },
  });
  return { reply, citations, intake, ...(submissionNumber ? { submissionNumber } : {}) };
}

async function replayPersistedTurn(assistant: ConversationMessage): Promise<ConversationTurnResult> {
  const result = isRecord(assistant.result) ? assistant.result : {};
  const submissionNumber = typeof result.submissionNumber === "string" ? result.submissionNumber : undefined;
  return { reply: assistant.text, citations: asPolicyCitations(assistant.citations), intake: null, ...(submissionNumber ? { submissionNumber } : {}) };
}

function asPolicyCitations(value: unknown): PolicyCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.excerpt !== "string" || !Array.isArray(item.headingPath) || !item.headingPath.every((part) => typeof part === "string") || typeof item.score !== "number") return [];
    return [{ id: item.id, title: item.title, url: item.url, excerpt: item.excerpt, headingPath: item.headingPath, score: item.score }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized || normalized.length > 2_000) throw new Error("message is invalid");
  return normalized;
}

function asPurpose(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
