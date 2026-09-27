import { buildConversationContext, type ConversationContext } from "@/src/application/build-conversation-context";
import type { AgentMessageChannel, AgentMessageRole, ReimbursementIntakeStatus } from "@/src/domain/agent-conversation";
import type { ConversationDecision, ChatModel } from "@/src/infrastructure/model/chat-model";
import type { PolicyCitation } from "@/src/application/search-policy-knowledge";

type ConversationRecord = { id: string; summary: string; summaryThroughSequence: number };
type ConversationMessage = { id?: string; sequence: number; role: AgentMessageRole; channel: AgentMessageChannel; text: string };
type IntakeRecord = {
  id: string;
  employeeId: string;
  conversationId: string;
  status: ReimbursementIntakeStatus;
  claimId: string | null;
  collectedFields: Record<string, unknown>;
  pendingFields: string[];
  submissionToken: string | null;
};

export type ConversationStore = {
  getConversationByIdOrThrow(id: string): Promise<ConversationRecord>;
  listMessages(input: { conversationId: string; limit?: number }): Promise<ConversationMessage[]>;
  appendMessage(input: { conversationId: string; role: AgentMessageRole; channel: AgentMessageChannel; text: string; citations?: Record<string, unknown>[]; result?: Record<string, unknown> }): Promise<unknown>;
  getCurrentIntake(employeeId: string): Promise<IntakeRecord | null>;
  createIntake(input: { employeeId: string; conversationId: string; claimId?: string | null; collectedFields?: Record<string, unknown>; pendingFields?: string[]; submissionToken?: string | null }): Promise<IntakeRecord>;
  updateIntake(input: { id: string; status?: ReimbursementIntakeStatus; claimId?: string | null; collectedFields?: Record<string, unknown>; pendingFields?: string[]; submissionToken?: string | null; lastUserConfirmationAt?: Date | null }): Promise<IntakeRecord>;
};

export type RunConversationTurnDeps = {
  conversations: ConversationStore;
  model: Pick<ChatModel, "classifyIntent" | "answerPolicy" | "decideConversation">;
  searchPolicy?: (query: string) => Promise<PolicyCitation[]>;
  createClaim?: (input: { actorId: string }) => Promise<{ id: string; version: number }>;
  uploadReceipt?: (input: { actorId: string; claimId: string; filename: string; mimeType: string; bytes: Uint8Array }) => Promise<{ id: string }>;
  extractReceipt?: (input: { actorId: string; claimId: string; receiptId: string }) => Promise<unknown>;
  updatePurpose?: (input: { actorId: string; claimId: string; value: string }) => Promise<{ version: number }>;
  requestSubmission?: (input: { actorId: string; claimId: string }) => Promise<{ token: string; claimId: string }>;
  submitClaim?: (input: { actorId: string; claimId: string; confirmationToken: string }) => Promise<{ submissionNumber: string }>;
};

export type ConversationTurnResult = {
  reply: string;
  citations: PolicyCitation[];
  intake: IntakeRecord | null;
  submissionNumber?: string;
};

export async function runConversationTurn(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; message: string; attachment?: { filename: string; mimeType: string; bytes: Uint8Array } },
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  const message = normalizeMessage(input.message);
  const conversation = await deps.conversations.getConversationByIdOrThrow(input.conversationId);
  await deps.conversations.appendMessage({ conversationId: conversation.id, role: "USER", channel: input.channel, text: message });
  const active = await getConversationIntake(input.actorId, conversation.id, deps.conversations);

  const attachment = input.attachment;
  if (attachment) return handleAttachment({ ...input, attachment }, active, deps);
  if (message === "确认提交") return confirmSubmission(input, active, deps);
  if (message === "开始报销") return startIntake(input, active, deps);

  if (await isPolicyQuestion(message, deps)) {
    return answerPolicyQuestion(input, active, message, deps);
  }

  const context = await getContext(conversation, active, deps.conversations, deps.searchPolicy, message);
  const decision: ConversationDecision = deps.model.decideConversation
    ? await deps.model.decideConversation(context)
    : { action: "ANSWER", reply: "我暂时无法处理这条报销办理请求，请在工作台继续填写。" };
  return applyDecision(input, active, decision, deps);
}

async function handleAttachment(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel; attachment: { filename: string; mimeType: string; bytes: Uint8Array } },
  active: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (!deps.createClaim || !deps.uploadReceipt) throw new Error("attachment handling is unavailable");
  let intake = active ?? await deps.conversations.createIntake({ employeeId: input.actorId, conversationId: input.conversationId, pendingFields: ["purpose"] });
  if (!intake.claimId) {
    const claim = await deps.createClaim({ actorId: input.actorId });
    intake = await deps.conversations.updateIntake({ id: intake.id, claimId: claim.id });
  }
  const receipt = await deps.uploadReceipt({ actorId: input.actorId, claimId: intake.claimId!, ...input.attachment });
  try {
    await deps.extractReceipt?.({ actorId: input.actorId, claimId: intake.claimId!, receiptId: receipt.id });
  } catch {
    return persistReply(input, intake, "票据已安全保存，但识别暂时失败。你可以稍后重新识别或手动补充信息。", [], deps.conversations);
  }
  return persistReply(input, intake, "票据已上传并进入识别流程。请继续补充本次报销事由。", [], deps.conversations);
}

async function startIntake(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel },
  active: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (active) {
    return persistReply(input, active, "当前已有一项进行中的报销办理，请继续补充信息或先完成提交。", [], deps.conversations);
  }
  const intake = await deps.conversations.createIntake({
    employeeId: input.actorId,
    conversationId: input.conversationId,
    pendingFields: ["purpose"],
  });
  return persistReply(input, intake, "已开始新的报销办理。请上传票据，或先告诉我本次报销事由。", [], deps.conversations);
}

async function answerPolicyQuestion(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel },
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
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel },
  intake: IntakeRecord | null,
  decision: ConversationDecision,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (decision.action === "COLLECT_FIELDS") {
    if (!intake) return persistReply(input, null, "请先输入“开始报销”或上传票据，再补充报销信息。", [], deps.conversations);
    const collectedFields = { ...intake.collectedFields, ...(decision.fields ?? {}) };
    if (intake.claimId && typeof decision.fields?.purpose === "string" && deps.updatePurpose) {
      await deps.updatePurpose({ actorId: input.actorId, claimId: intake.claimId, value: decision.fields.purpose });
    }
    const pendingFields = intake.pendingFields.filter((field) => !(field in (decision.fields ?? {})));
    const updated = await deps.conversations.updateIntake({ id: intake.id, collectedFields, pendingFields });
    return persistReply(input, updated, decision.reply, [], deps.conversations);
  }

  if (decision.action === "REQUEST_SUBMISSION") {
    if (!intake?.claimId || !deps.requestSubmission) return persistReply(input, intake, "请先上传票据并补齐必填信息，再生成提交摘要。", [], deps.conversations);
    const preview = await deps.requestSubmission({ actorId: input.actorId, claimId: intake.claimId });
    const updated = await deps.conversations.updateIntake({ id: intake.id, status: "READY_TO_SUBMIT", submissionToken: preview.token });
    return persistReply(input, updated, decision.reply, [], deps.conversations);
  }

  return persistReply(input, intake, decision.reply, [], deps.conversations);
}

async function confirmSubmission(
  input: { actorId: string; conversationId: string; channel: AgentMessageChannel },
  intake: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<ConversationTurnResult> {
  if (!intake || intake.status !== "READY_TO_SUBMIT" || !intake.claimId || !intake.submissionToken || !deps.submitClaim) {
    throw new Error("no ready Intake");
  }
  const submitted = await deps.submitClaim({ actorId: input.actorId, claimId: intake.claimId, confirmationToken: intake.submissionToken });
  const updated = await deps.conversations.updateIntake({ id: intake.id, status: "SUBMITTED", lastUserConfirmationAt: new Date() });
  return persistReply(input, updated, `报销单已提交，提交编号：${submitted.submissionNumber}。`, [], deps.conversations, submitted.submissionNumber);
}

async function getContext(
  conversation: ConversationRecord,
  intake: IntakeRecord | null,
  conversations: ConversationStore,
  searchPolicy: RunConversationTurnDeps["searchPolicy"],
  message: string,
): Promise<ConversationContext> {
  const [messages, citations] = await Promise.all([
    conversations.listMessages({ conversationId: conversation.id, limit: 50 }),
    searchPolicy ? searchPolicy(message).catch(() => []) : Promise.resolve([]),
  ]);
  return buildConversationContext({
    conversation,
    messages,
    intake,
    policyCitations: citations,
  });
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
  input: { conversationId: string; channel: AgentMessageChannel },
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
    text: reply,
    citations: citations.map(({ id, title, url, excerpt, headingPath, score }) => ({ id, title, url, excerpt, headingPath, score })),
    result: { intakeId: intake?.id ?? null, claimId: intake?.claimId ?? null, submissionNumber: submissionNumber ?? null },
  });
  return { reply, citations, intake, ...(submissionNumber ? { submissionNumber } : {}) };
}

function normalizeMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized || normalized.length > 2_000) throw new Error("message is invalid");
  return normalized;
}
