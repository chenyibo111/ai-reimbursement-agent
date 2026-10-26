import { buildConversationContext, type ConversationContext } from "@/src/application/build-conversation-context";
import type { AgentMessageChannel, AgentMessageRole, ReimbursementIntakeStatus } from "@/src/domain/agent-conversation";
import type { ConversationDecision, ChatModel } from "@/src/infrastructure/model/chat-model";
import type { PolicyCitation, PolicySearchResult } from "@/src/application/search-policy-knowledge";
import { formatClaimFacts, type ClaimFactKind } from "@/src/application/format-claim-facts";
import type { ClaimFieldPatch, ClaimSnapshot, ReceiptSnapshot, ValidationSnapshot } from "@/services/agent/src/ports/reimbursement-port";
import { ReimbursementApiHttpError } from "@/services/agent/src/adapters/reimbursement-api-client";
import { formatClaimSearchPage, normalizeClaimSearch, readClaimSearchState } from "@/src/application/claim-search";
import type { OwnedClaimSearchPage, OwnedClaimSearchQuery } from "@/services/agent/src/ports/reimbursement-port";

type ConversationRecord = { id: string; summary: string; summaryThroughSequence: number; selectedReadClaimId?: string | null; searchState?: unknown };
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
  restartRequestedAt?: Date | null;
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
  updateIntake(input: { id: string; status?: ReimbursementIntakeStatus; claimId?: string | null; collectedFields?: Record<string, unknown>; pendingFields?: string[]; submissionToken?: string | null; submissionPreview?: Record<string, unknown> | null; restartRequestedAt?: Date | null; lastUserConfirmationAt?: Date | null }): Promise<IntakeRecord>;
  restartIntake(input: { employeeId: string; conversationId: string; intakeId: string; requestedAfter: Date }): Promise<IntakeRecord>;
  setSelectedReadClaimId?(input: { conversationId: string; claimId: string | null }): Promise<void>;
  setSearchState?(input: { conversationId: string; state: import("@/src/application/claim-search").ClaimSearchState | null }): Promise<void>;
};

export type RunConversationTurnDeps = {
  conversations: ConversationStore;
  model: Pick<ChatModel, "classifyIntent" | "answerPolicy" | "decideConversation">;
  searchPolicy?: (query: string) => Promise<PolicySearchResult>;
  createClaim?: (input: { actorId: string; purpose?: string }) => Promise<{ id: string; version: number }>;
  preflightAttachment?: (input: { filename: string; mimeType: string; bytes: Uint8Array }) => Promise<void>;
  uploadReceipt?: (input: { actorId: string; claimId: string; filename: string; mimeType: string; bytes: Uint8Array; notificationTarget?: { conversationId: string; chatId: string } }) => Promise<{ id: string; jobId?: string }>;
  extractReceipt?: (input: { actorId: string; claimId: string; receiptId: string }) => Promise<unknown>;
  updatePurpose?: (input: { actorId: string; claimId: string; value: string }) => Promise<{ version: number }>;
  updateFields?: (input: { actorId: string; claimId: string; fields: ClaimFieldPatch }) => Promise<ClaimSnapshot>;
  readWorkbench?: (input: { actorId: string; claimId: string }) => Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>;
  listOwnedClaims?: (input: { actorId: string; limit: number }) => Promise<ClaimSnapshot[]>;
  searchOwnedClaims?: (input: { actorId: string; query: OwnedClaimSearchQuery }) => Promise<OwnedClaimSearchPage>;
  findOwnedClaimByNumber?: (input: { actorId: string; claimNumber: string }) => Promise<ClaimSnapshot | null>;
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
      throw new Error("inbound turn is already processing");
    }
  } else {
    await deps.conversations.appendMessage({ conversationId: conversation.id, role: "USER", channel: input.channel, channelMessageId: input.channelMessageId, text: message });
  }
  let active = await getConversationIntake(input.actorId, conversation.id, deps.conversations);
  if (input.channel === "FEISHU" && input.chatType !== "p2p") active = null;
  else {
    const reconciliation = await reconcileIntakeFields(input.actorId, active, deps);
    active = reconciliation.intake;
    if (reconciliation.warning) return persistReply(input, active, reconciliation.warning, [], deps.conversations);
  }

  const attachment = input.attachment;
  if (attachment && input.channel === "FEISHU" && input.chatType !== "p2p") {
    return persistReply(input, null, "为保护报销信息，请私聊机器人或在 Web 工作台上传票据。", [], deps.conversations);
  }
  if (attachment) return handleAttachment({ ...input, attachment }, active, deps);
  if (message === "确认提交" && input.channel === "FEISHU" && input.chatType !== "p2p") {
    return persistReply(input, null, "为保护报销信息，请私聊机器人或在 Web 工作台发起并确认提交。", [], deps.conversations);
  }
  if (message === "确认提交") return confirmSubmission(input, active, deps);
  const context = await getContext(conversation, active, deps.conversations);
  let decision: ConversationDecision;
  try {
    if (!deps.model.decideConversation) throw new Error("intent model unavailable");
    decision = await deps.model.decideConversation(context);
  } catch {
    return persistReply(input, active, "暂时无法判断你的办理需求，请明确说明，或在 Web 工作台继续办理。", [], deps.conversations);
  }
  if (active?.restartRequestedAt && decision.action !== "START_INTAKE") {
    active = await deps.conversations.updateIntake({ id: active.id, restartRequestedAt: null });
  }
  if (decision.action === "POLICY_QUERY") return answerPolicyQuestion(input, active, message, deps);
  return applyDecision(input, active, decision, deps, conversation.selectedReadClaimId ?? null, conversation.searchState);
}

async function reconcileIntakeFields(
  actorId: string,
  intake: IntakeRecord | null,
  deps: RunConversationTurnDeps,
): Promise<{ intake: IntakeRecord | null; warning?: string }> {
  if (!intake || !Object.keys(intake.collectedFields).length) return { intake };
  let claim: ClaimSnapshot | null = null;
  if (intake.claimId) {
    if (!deps.readWorkbench) return { intake, warning: "暂时无法核对会话中的报销字段，本次请求未继续处理。请稍后到工作台确认后重试。" };
    try {
      claim = (await deps.readWorkbench({ actorId, claimId: intake.claimId })).claim;
    } catch {
      return { intake, warning: "暂时无法核对会话中的报销字段，本次请求未继续处理。请稍后到工作台确认后重试。" };
    }
  }
  const fieldLabels: Record<string, string> = { purpose: "报销事由", expenseCategory: "费用类别", participants: "参与人员", projectCode: "项目编号" };
  const verified: Record<string, unknown> = {};
  const unverified: string[] = [];
  for (const [name, value] of Object.entries(intake.collectedFields)) {
    if (claim && name in fieldLabels && JSON.stringify(claim[name as keyof ClaimSnapshot]) === JSON.stringify(value)) verified[name] = value;
    else unverified.push(fieldLabels[name] ?? "其他旧会话字段");
  }
  if (!unverified.length) return { intake };
  const safe = await clearSubmissionPreparation(intake, deps.conversations);
  const updated = await deps.conversations.updateIntake({
    id: safe.id,
    collectedFields: verified,
    pendingFields: unverified.includes("报销事由") ? [...new Set([...safe.pendingFields, "purpose"])] : safe.pendingFields,
  });
  return {
    intake: updated,
    warning: `旧会话中的${[...new Set(unverified)].join("、")}未保存到当前报销单，已从会话记录移除；请核对工作台并重新确认这些字段。本次请求未继续处理，请重新发送。`,
  };
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
      await deps.conversations.setSelectedReadClaimId?.({ conversationId: input.conversationId, claimId: null });
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
    if (hasPendingRestart(active)) {
      try {
        const restarted = await deps.conversations.restartIntake({
          employeeId: input.actorId,
          conversationId: input.conversationId,
          intakeId: active.id,
          requestedAfter: new Date(Date.now() - 10 * 60_000),
        });
        await deps.conversations.setSelectedReadClaimId?.({ conversationId: input.conversationId, claimId: null });
        return persistReply(input, restarted, "已开始新的报销办理。请上传票据，或先告诉我本次报销事由。", [], deps.conversations);
      } catch {
        return persistReply(input, active, "暂时无法新建报销，请在工作台核对当前单据后重试。", [], deps.conversations);
      }
    }
    const awaiting = await deps.conversations.updateIntake({ id: active.id, restartRequestedAt: new Date() });
    return persistReply(input, awaiting, "你已有一项正在办理的报销。若确定放弃当前办理并另起一单，请再明确告诉我；否则可继续上传票据或补充信息。", [], deps.conversations);
  }
  let intake: IntakeRecord;
  try {
    intake = await deps.conversations.createIntake({
      employeeId: input.actorId,
      conversationId: input.conversationId,
      pendingFields: ["purpose"],
    });
    await deps.conversations.setSelectedReadClaimId?.({ conversationId: input.conversationId, claimId: null });
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
    const result = await deps.searchPolicy?.(message) ?? { evidence: [], citations: [], incomplete: false };
    const { citations } = result;
    const reply = !citations.length
      ? "当前没有可供引用的已同步报销政策，请以公司财务制度为准。"
      : result.incomplete || !result.evidence.length
        ? "检索到相关制度，但无法读取完整章节，请查看引用原文；我暂不能据此给出完整规则。"
        : await answerFromEvidence(message, result.evidence, deps.model);
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
  selectedReadClaimId: string | null,
  rawSearchState: unknown,
): Promise<ConversationTurnResult> {
  if (input.channel === "FEISHU" && input.chatType !== "p2p" && ["START_INTAKE", "COLLECT_FIELDS", "LIST_CLAIMS", "SEARCH_CLAIMS", "NEXT_CLAIMS_PAGE", "READ_CLAIM", "READ_RECEIPT_AMOUNT", "READ_SUBMISSION_SUMMARY", "PREPARE_SUBMISSION"].includes(decision.action)) {
    return persistReply(input, null, "为保护报销信息，请私聊机器人或在 Web 工作台办理、查询与提交。", [], deps.conversations);
  }
  if (decision.action === "START_INTAKE") return startIntake(input, intake, deps);
  if (decision.action === "CLARIFY") return persistReply(input, intake, clarificationReply(decision.clarificationReason), [], deps.conversations);
  if (decision.action === "OUT_OF_SCOPE") return persistReply(input, intake, "我目前只能协助报销政策问答、票据和报销单办理；其他事项请使用相应服务。", [], deps.conversations);
  if (decision.action === "HELP") return persistReply(input, intake, helpReply(), [], deps.conversations);
  if (decision.action === "SEARCH_CLAIMS") {
    await deps.conversations.setSearchState?.({ conversationId: input.conversationId, state: null });
    if (!deps.searchOwnedClaims || !deps.conversations.setSearchState) return persistReply(input, intake, "报销查询暂不可用，请稍后重试。", [], deps.conversations);
    try {
      const { query, requestedCount } = normalizeClaimSearch(decision.search, new Date());
      const page = await deps.searchOwnedClaims({ actorId: input.actorId, query: { ...query, limit: query.countOnly ? 1 : Math.min(10, requestedCount) } });
      if (query.countOnly) return persistReply(input, intake, `查询时共 ${page.totalCount} 张本人报销单。`, [], deps.conversations);
      const formatted = formatClaimSearchPage(page, query, requestedCount, new Date());
      await deps.conversations.setSearchState({ conversationId: input.conversationId, state: formatted.state });
      return persistReply(input, intake, formatted.reply, [], deps.conversations);
    } catch { return persistReply(input, intake, "查询条件无效或报销服务暂不可用，请调整条件后重试。", [], deps.conversations); }
  }
  if (decision.action === "NEXT_CLAIMS_PAGE") {
    const state = readClaimSearchState(rawSearchState, new Date());
    if (!state?.cursor || !state.remaining || !deps.searchOwnedClaims || !deps.conversations.setSearchState) return persistReply(input, intake, "当前没有可继续查看的查询页，请重新描述查询条件。", [], deps.conversations);
    try {
      const page = await deps.searchOwnedClaims({ actorId: input.actorId, query: { ...state.query, limit: Math.min(10, state.remaining), cursor: state.cursor } });
      const formatted = formatClaimSearchPage(page, state.query, state.remaining, new Date());
      await deps.conversations.setSearchState({ conversationId: input.conversationId, state: formatted.state });
      return persistReply(input, intake, formatted.reply, [], deps.conversations);
    } catch { await deps.conversations.setSearchState({ conversationId: input.conversationId, state: null }); return persistReply(input, intake, "查询页已失效，请重新查询。", [], deps.conversations); }
  }
  if (decision.action === "LIST_CLAIMS") {
    if (!deps.listOwnedClaims) return persistReply(input, intake, "报销数据暂时无法查询，请稍后重试。", [], deps.conversations);
    try {
      const claims = (await deps.listOwnedClaims({ actorId: input.actorId, limit: 5 })).slice(0, 5);
      const reply = claims.length ? `最近的本人报销单：\n${claims.map((claim) => `${claim.claimNumber}｜${claim.status}｜${claim.purpose || "未填写事由"}`).join("\n")}\n如需详情，请提供报销单号。` : "暂未查到本人报销单。";
      return persistReply(input, intake, reply, [], deps.conversations);
    } catch { return persistReply(input, intake, "报销数据暂时无法查询，请稍后重试。", [], deps.conversations); }
  }
  if (decision.action === "READ_CLAIM" || decision.action === "READ_RECEIPT_AMOUNT" || decision.action === "READ_SUBMISSION_SUMMARY") {
    if (!deps.readWorkbench || (decision.action === "READ_SUBMISSION_SUMMARY" && !deps.readValidation)) return persistReply(input, intake, "报销数据暂时无法查询，请稍后重试。", [], deps.conversations);
    try {
      let claimId = selectedReadClaimId ?? intake?.claimId ?? null;
      if (decision.claimOrdinal !== undefined) {
        const state = readClaimSearchState(rawSearchState, new Date());
        const selected = state?.lastPage.find((item) => item.ordinal === decision.claimOrdinal);
        if (!selected) return persistReply(input, intake, "当前列表已过期或序号无效，请重新查询后选择。", [], deps.conversations);
        claimId = selected.id;
        await deps.conversations.setSelectedReadClaimId?.({ conversationId: input.conversationId, claimId });
      }
      if (decision.claimNumber) {
        const number = decision.claimNumber.toUpperCase();
        if (!/^BX[0-9]{8}-[0-9]{4,}$/.test(number)) {
          await deps.conversations.setSelectedReadClaimId?.({ conversationId: input.conversationId, claimId: null });
          return persistReply(input, intake, "报销单号格式无效，请提供完整单号。", [], deps.conversations);
        }
        if (!deps.findOwnedClaimByNumber || !deps.conversations.setSelectedReadClaimId) return persistReply(input, intake, "报销数据暂时无法查询，请稍后重试。", [], deps.conversations);
        const found = await deps.findOwnedClaimByNumber({ actorId: input.actorId, claimNumber: number });
        if (!found) {
          await deps.conversations.setSelectedReadClaimId({ conversationId: input.conversationId, claimId: null });
          return persistReply(input, intake, "未找到该报销单，或你无权访问。请核对单号。", [], deps.conversations);
        }
        claimId = found.id;
        await deps.conversations.setSelectedReadClaimId({ conversationId: input.conversationId, claimId });
      }
      if (!claimId && deps.listOwnedClaims) {
        const candidates = await deps.listOwnedClaims({ actorId: input.actorId, limit: 2 });
        if (candidates.length === 1) {
          claimId = candidates[0].id;
          await deps.conversations.setSelectedReadClaimId?.({ conversationId: input.conversationId, claimId });
        } else if (candidates.length > 1) return persistReply(input, intake, "你有多张报销单，请提供要查询的报销单号。", [], deps.conversations);
      }
      if (!claimId) return persistReply(input, intake, "当前会话没有绑定报销单。请提供已有报销单号，或输入“开始报销”，也可在 Web 工作台查看。", [], deps.conversations);
      const workbench = await deps.readWorkbench({ actorId: input.actorId, claimId });
      const validation = decision.action === "READ_SUBMISSION_SUMMARY" ? await deps.readValidation!({ actorId: input.actorId, claimId }) : undefined;
      return persistReply(input, intake, formatClaimFacts(decision.action as ClaimFactKind, workbench, validation), [], deps.conversations);
    } catch (error) {
      return persistReply(input, intake, claimReadErrorReply(error), [], deps.conversations);
    }
  }
  if (decision.action === "COLLECT_FIELDS") {
    if (!intake) return persistReply(input, null, "请先输入“开始报销”或上传票据，再补充报销信息。", [], deps.conversations);
    const fields = validFieldPatch(decision.fields);
    if (!fields) return persistReply(input, intake, "这项信息不能在对话中保存；金额、币种和备注请到 Web 工作台填写。", [], deps.conversations);
    if (!deps.createClaim || !deps.updateFields) return persistReply(input, intake, "报销服务暂不可用，未确认写入。请稍后重试。", [], deps.conversations);
    let bound = intake;
    if (!bound.claimId) {
      try {
        const claim = await deps.createClaim({ actorId: input.actorId });
        bound = await deps.conversations.updateIntake({ id: intake.id, claimId: claim.id });
      } catch {
        return persistReply(input, intake, "暂时无法创建报销草稿，本次信息未确认写入，请稍后重试。", [], deps.conversations);
      }
    }
    let actual: ClaimSnapshot;
    try {
      actual = await deps.updateFields({ actorId: input.actorId, claimId: bound.claimId!, fields });
    } catch {
      const safe = await clearSubmissionPreparation(bound, deps.conversations);
      return persistReply(input, safe, "报销草稿可能已创建，但字段未确认写入。请到工作台核对后重试。", [], deps.conversations);
    }
    const verified = Object.fromEntries(Object.entries(fields).filter(([name, value]) => JSON.stringify(actual[name as keyof ClaimSnapshot]) === JSON.stringify(value))) as ClaimFieldPatch;
    const safe = await clearSubmissionPreparation(bound, deps.conversations);
    if (!Object.keys(verified).length) return persistReply(input, safe, "字段写入结果与报销单回读不一致，未确认保存；请到工作台核对后重试。", [], deps.conversations);
    const updated = await deps.conversations.updateIntake({
      id: safe.id,
      collectedFields: { ...safe.collectedFields, ...verified },
      pendingFields: safe.pendingFields.filter((field) => !(field in verified)),
    });
    const fieldLabels: Record<string, string> = { purpose: "报销事由", expenseCategory: "费用类别", participants: "参与人员", projectCode: "项目编号" };
    const saved = Object.entries(verified).map(([name, value]) => `${fieldLabels[name] ?? name}：${Array.isArray(value) ? value.join("、") : value}`);
    const partial = Object.keys(verified).length !== Object.keys(fields).length;
    return persistReply(input, updated, `已保存到报销草稿：${saved.join("；")}。${partial ? "其余字段未确认写入，请到工作台核对或重试。" : ""}`, [], deps.conversations);
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

function validFieldPatch(value: ConversationDecision["fields"]): ClaimFieldPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  const fields: ClaimFieldPatch = {};
  for (const [name, raw] of entries) {
    if (name === "participants" && Array.isArray(raw) && raw.length >= 1 && raw.length <= 20 && raw.every((item) => typeof item === "string" && Array.from(item.trim()).length >= 1 && Array.from(item.trim()).length <= 80)) {
      const participants = raw.map((item: string) => item.trim());
      if (new Set(participants).size !== participants.length) return null;
      fields.participants = participants;
    } else if ((name === "purpose" || name === "expenseCategory" || name === "projectCode") && typeof raw === "string" && Array.from(raw.trim()).length >= 1 && Array.from(raw.trim()).length <= 200) {
      fields[name] = raw.trim();
    } else return null;
  }
  return fields;
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
): Promise<ConversationContext> {
  const messages = await conversations.listMessages({ conversationId: conversation.id, limit: 200 });
  const summarizedConversation = await summarizeOlderMessages(conversation, messages, conversations);
  return buildConversationContext({
    conversation: summarizedConversation,
    messages,
    intake,
    policyCitations: [],
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

function hasPendingRestart(intake: IntakeRecord): boolean {
  const requestedAt = intake.restartRequestedAt?.getTime();
  return requestedAt !== undefined && requestedAt <= Date.now() && requestedAt >= Date.now() - 10 * 60_000;
}

function clarificationReply(reason: ConversationDecision["clarificationReason"]): string {
  if (reason === "POLICY_OR_CLAIM") return "请明确你想了解公司报销政策，还是查询当前这张报销单的校验结果。";
  if (reason === "START_OR_HELP") return "请明确你要新建一笔报销，还是只想了解办理流程。";
  if (reason === "MULTIPLE_ACTIONS") return "你提出了多个操作，请先明确这次要查询、补充信息，还是准备提交。";
  if (reason === "UNCLEAR_REFERENCE") return "请明确你指的是哪张票据或报销单，以及希望我查询什么。";
  return "请明确说明你希望我帮你处理的报销事项。";
}

function helpReply(): string {
  return [
    "我目前可以帮你：",
    "1. 查询已同步的报销政策和规则，并附上政策依据。",
    "2. 开始报销、上传票据，并在识别完成后查看识别结果。",
    "3. 为当前草稿补充报销事由、费用类别、参与人员和项目编号。",
    "4. 列出本人最近 5 张报销单；提供完整单号后，可查询单据状态、事由、申请报销总额和票据金额。",
    "5. 查看提交条件、生成提交前摘要；核对后回复“确认提交”，才会提交当前办理的报销单。",
    "金额、币种和备注请到 Web 工作台填写；票据识别结果如需人工修改，也请到工作台处理。本人单据的查询和办理请在飞书私聊进行。",
    "例如，你可以说：“我的报销单”“开始报销”“这单还缺什么”。",
  ].join("\n");
}

async function answerFromEvidence(message: string, evidence: PolicySearchResult["evidence"], model: RunConversationTurnDeps["model"]): Promise<string> {
  try {
    const reply = await model.answerPolicy?.({ question: message, sources: evidence.map(({ title, text, headingPath }) => ({ title, excerpt: text, headingPath })) });
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
