import { runConversationTurn, type ConversationStore, type RunConversationTurnDeps } from "@/src/application/run-conversation-turn";
import { fixtureDecision, type AgentWorkflowCase, type ObservedWorkflowTurn } from "@/src/application/evaluate-agent-workflow";
import type { ChatModel } from "@/src/infrastructure/model/chat-model";
import type { ClaimSnapshot, ReceiptSnapshot, ReimbursementPort, ToolCallContext } from "@/services/agent/src/ports/reimbursement-port";
import { ReimbursementToolGateway, type ToolCall, type ToolCallResultStore } from "@/services/agent/src/tool-gateway/reimbursement-tools";
import { createConversationReimbursementTools } from "@/services/agent/src/tool-gateway/conversation-reimbursement";
import { ChatModelError } from "@/src/infrastructure/model/openai-compatible-chat-model";

type SeedClaim = AgentWorkflowCase["initial"]["claims"][number];
type StoredClaim = { ownerId: string; claim: ClaimSnapshot; receipts: ReceiptSnapshot[]; issues: NonNullable<SeedClaim["issues"]> };

/** No external I/O: the same gateway and orchestration used in production run against an isolated port. */
export async function replayAgentWorkflow(item: AgentWorkflowCase, model?: Pick<ChatModel, "decideConversation" | "answerPolicy">): Promise<ObservedWorkflowTurn[]> {
  const actorId = "employee-1";
  const conversationId = `eval:${item.id}`;
  const claims = new Map<string, StoredClaim>(item.initial.claims.map((seed) => [seed.id, {
    ownerId: seed.ownerId,
    claim: { id: seed.id, claimNumber: seed.claimNumber, version: seed.version, status: seed.status, purpose: seed.purpose, expenseCategory: seed.expenseCategory, participants: seed.participants, projectCode: seed.projectCode, totalAmountCent: seed.totalAmountCent, requestedAmountCent: seed.requestedAmountCent, currency: "CNY", receiptCount: seed.receipts.length },
    receipts: seed.receipts.map((receipt) => ({ ...receipt, claimId: seed.id })), issues: seed.issues ?? [],
  }]));
  let nextClaim = 1;
  let nextReceipt = 1;
  const submittedTokens = new Map<string, string>();
  const own = (context: ToolCallContext, claimId: string): StoredClaim => {
    const found = claims.get(claimId);
    if (!found || found.ownerId !== context.actorEmployeeId) throw new Error("NOT_FOUND");
    return found;
  };
  const port: ReimbursementPort = {
    async createClaimDraft(input) {
      const id = `created-${nextClaim++}`;
      const claim: ClaimSnapshot = { id, claimNumber: `BX20261029-${String(nextClaim).padStart(4, "0")}`, status: "DRAFT", version: 1, purpose: input.purpose || null, totalAmountCent: null, requestedAmountCent: null, currency: "CNY", receiptCount: 0 };
      claims.set(id, { ownerId: input.actorEmployeeId, claim, receipts: [], issues: [] });
      return { ...claim };
    },
    async createUploadSession(input) { own(input, input.claimId); return { receiptId: `receipt-${nextReceipt++}`, uploadUrl: "https://eval.invalid/fixture" }; },
    async finalizeReceiptUpload(input) {
      const found = own(input, input.claimId);
      found.receipts.push({ id: input.receiptId, claimId: input.claimId, filename: `fixture-${input.receiptId}`, status: "READY_FOR_OCR", invoiceNumber: "", ocrConfidence: 0, totalAmountCent: null });
      found.claim.receiptCount = found.receipts.length;
      found.claim.version++;
      return { receiptId: input.receiptId, status: "READY_FOR_OCR" };
    },
    async deleteOwnedReceipt(input) { const found = own(input, input.claimId); if (found.claim.version !== input.expectedClaimVersion || found.claim.status !== "DRAFT") throw new Error("VERSION_CONFLICT"); found.receipts = found.receipts.filter((receipt) => receipt.id !== input.receiptId); found.claim.receiptCount = found.receipts.length; found.claim.version++; },
    async deleteOwnedDraft(input) { const found = own(input, input.claimId); if (found.claim.version !== input.expectedClaimVersion || found.claim.status !== "DRAFT") throw new Error("VERSION_CONFLICT"); claims.delete(input.claimId); },
    async getClaimWorkbench(input) { const found = own(input, input.claimId); return { claim: { ...found.claim }, receipts: found.receipts.map((receipt) => ({ ...receipt })) }; },
    async listOwnedClaims(input) { return [...claims.values()].filter((entry) => entry.ownerId === input.actorEmployeeId).slice(0, input.limit).map((entry) => ({ ...entry.claim })); },
    async searchOwnedClaims(input) {
      const q = input.query;
      let values = [...claims.values()].filter((entry) => entry.ownerId === input.actorEmployeeId);
      if (q.status) values = values.filter((entry) => entry.claim.status === q.status);
      if (q.purposeContains) values = values.filter((entry) => entry.claim.purpose?.includes(q.purposeContains!) ?? false);
      if (q.expenseCategory) values = values.filter((entry) => entry.claim.expenseCategory === q.expenseCategory);
      if (q.minRequestedAmountCent !== undefined) values = values.filter((entry) => (entry.claim.requestedAmountCent ?? -1) >= q.minRequestedAmountCent!);
      if (q.maxRequestedAmountCent !== undefined) values = values.filter((entry) => (entry.claim.requestedAmountCent ?? Infinity) <= q.maxRequestedAmountCent!);
      const totalCount = values.length;
      const offset = Number(q.cursor ?? "0");
      const page = values.slice(offset, offset + q.limit).map((entry) => ({ ...entry.claim }));
      return { items: page, totalCount, nextCursor: offset + page.length < totalCount ? String(offset + page.length) : null };
    },
    async findOwnedClaimByNumber(input) { const found = [...claims.values()].find((entry) => entry.ownerId === input.actorEmployeeId && entry.claim.claimNumber === input.claimNumber); return found ? { ...found.claim } : null; },
    async updateClaimFields(input) { const found = own(input, input.claimId); if (found.claim.status !== "DRAFT" || found.claim.version !== input.version) throw new Error("VERSION_CONFLICT"); Object.assign(found.claim, input.fields); found.claim.version++; return { ...found.claim }; },
    async getClaimValidation(input) { const found = own(input, input.claimId); return { claimId: input.claimId, claimVersion: found.claim.version, policyVersion: "fixture-policy-v1", issues: found.issues }; },
    async getOwnedClaimProgress(input) { const found = own(input, input.claimId); return { claimId: input.claimId, claimNumber: found.claim.claimNumber, status: found.claim.status as "DRAFT" | "SUBMITTED", version: found.claim.version, submissionNumber: found.claim.status === "SUBMITTED" ? `SUB-${found.claim.claimNumber}` : null, submittedAt: null, receipts: found.receipts.map((receipt) => ({ receiptId: receipt.id, filename: receipt.filename, status: receipt.status, reviewStatus: "NONE" as const })), issues: found.issues, approval: "NOT_CONNECTED", payment: "NOT_CONNECTED" }; },
    async requestSubmissionConfirmation(input) { const found = own(input, input.claimId); if (found.claim.status !== "DRAFT" || found.claim.version !== input.version || found.issues.some((issue) => issue.severity === "BLOCKING")) throw new Error("VALIDATION_BLOCKED"); const confirmationToken = `token-${input.claimId}-${input.version}`; submittedTokens.set(input.claimId, confirmationToken); return { confirmationToken, claimId: input.claimId, claimVersion: input.version }; },
    async submitClaim(input) { const found = own(input, input.claimId); if (found.claim.status !== "DRAFT" || submittedTokens.get(input.claimId) !== input.confirmationToken) throw new Error("CONFIRMATION_EXPIRED"); found.claim.status = "SUBMITTED"; found.claim.version++; submittedTokens.delete(input.claimId); return { claimId: input.claimId, submissionNumber: `SUB-${found.claim.claimNumber}` }; },
  };
  const calls: ToolCall[] = [];
  const resultCache = new Map<string, Record<string, unknown>>();
  const results: ToolCallResultStore = { findCompleted: async (id) => resultCache.get(id) ?? null, saveCompleted: async (input) => { resultCache.set(input.toolCallId, input.result); } };
  class RecordingGateway extends ReimbursementToolGateway {
    override async execute(call: ToolCall) { calls.push(call); return super.execute(call); }
  }
  const gateway = new RecordingGateway(port, results);
  const tools = createConversationReimbursementTools(gateway, async () => new Response(null, { status: 200 }));
  const conversation = { id: conversationId, summary: "", summaryThroughSequence: 0, selectedReadClaimId: item.initial.selectedReadClaimId ?? null as string | null, selectedEditClaimId: item.initial.selectedEditClaimId ?? null as string | null, searchState: null as unknown, pendingAction: null as unknown };
  const messages: Array<{ sequence: number; role: "USER" | "ASSISTANT" | "SYSTEM"; channel: "WEB" | "FEISHU"; text: string }> = [];
  type Intake = NonNullable<Awaited<ReturnType<ConversationStore["getCurrentIntake"]>>>;
  let intake: Intake | null = item.initial.intake ? { id: "intake-1", employeeId: actorId, conversationId, status: item.initial.intake.status, claimId: item.initial.intake.claimId, collectedFields: item.initial.intake.collectedFields ?? {}, pendingFields: item.initial.intake.pendingFields ?? [], submissionToken: null, submissionPreview: null } : null;
  const store: ConversationStore = {
    getConversationByIdOrThrow: async () => ({ ...conversation }),
    listMessages: async () => [...messages],
    appendMessage: async (input) => { messages.push({ sequence: messages.length + 1, role: input.role, channel: input.channel, text: input.text }); return { sequence: messages.length }; },
    getCurrentIntake: async () => intake,
    createIntake: async (input) => { intake = { id: `intake-${messages.length}`, employeeId: input.employeeId, conversationId: input.conversationId, status: "COLLECTING", claimId: input.claimId ?? null, collectedFields: input.collectedFields ?? {}, pendingFields: input.pendingFields ?? ["purpose"], submissionToken: input.submissionToken ?? null, submissionPreview: input.submissionPreview ?? null }; return intake; },
    updateIntake: async (input) => { if (!intake || intake.id !== input.id) throw new Error("intake unavailable"); intake = { ...intake, ...input }; return intake; },
    restartIntake: async (input) => { intake = { id: `intake-${messages.length}`, employeeId: input.employeeId, conversationId: input.conversationId, status: "COLLECTING", claimId: null, collectedFields: {}, pendingFields: ["purpose"], submissionToken: null }; return intake; },
    setSelectedReadClaimId: async ({ claimId }) => { conversation.selectedReadClaimId = claimId; },
    setSelectedEditClaimId: async ({ claimId }) => { conversation.selectedEditClaimId = claimId; },
    setSearchState: async ({ state }) => { conversation.searchState = state; },
    setPendingAction: async ({ action }) => { conversation.pendingAction = action; },
    consumePendingAction: async ({ action }) => { if (JSON.stringify(conversation.pendingAction) !== JSON.stringify(action)) return false; conversation.pendingAction = null; return true; },
    compareAndSetSummary: async () => true,
  };
  const observed: ObservedWorkflowTurn[] = [];
  for (const [index, turn] of item.turns.entries()) {
    let action = turn.message === "确认提交" ? "CONFIRM_SUBMISSION" : turn.message === "确认删除票据" ? "CONFIRM_DELETE_RECEIPT" : turn.message === "确认删除报销单" ? "CONFIRM_DELETE_DRAFT" : turn.attachment ? "START_INTAKE" : "MODEL_NOT_CALLED";
    let modelFailure: ObservedWorkflowTurn["modelFailure"];
    const failureCode = (error: unknown): NonNullable<ObservedWorkflowTurn["modelFailure"]>["code"] => error instanceof ChatModelError ? error.code : "OTHER";
    const currentModel: RunConversationTurnDeps["model"] = {
      decideConversation: async (context) => {
        try { const decision = model?.decideConversation ? await model.decideConversation(context) : fixtureDecision(turn); action = decision.action; return decision; }
        catch (error) { action = "MODEL_ERROR"; modelFailure = { stage: "decision", code: failureCode(error) }; throw error; }
      },
      answerPolicy: async (input) => {
        try { return model?.answerPolicy ? await model.answerPolicy(input) : item.initial.policy?.answer ?? ""; }
        catch (error) { modelFailure = { stage: "policy_answer", code: failureCode(error) }; throw error; }
      },
    };
    const context = { actorId, actorRole: "EMPLOYEE" as const, channel: item.channel, conversationId, turnId: `turn-${index + 1}` };
    const before = calls.length;
    const deps: RunConversationTurnDeps = {
      conversations: store, model: currentModel,
      searchPolicy: async () => item.initial.policy ? { evidence: [{ sectionId: "fixture-section", title: item.initial.policy.citationTitle, headingPath: [], text: item.initial.policy.evidenceText, complete: true }], citations: [{ id: "fixture-citation", title: item.initial.policy.citationTitle, url: item.initial.policy.citationUrl, excerpt: item.initial.policy.evidenceText, headingPath: [], score: 1 }], incomplete: false } : { evidence: [], citations: [], incomplete: false },
      createClaim: ({ purpose }) => tools.createClaim(context, purpose),
      preflightAttachment: async () => undefined,
      uploadReceipt: async ({ claimId, filename, mimeType, bytes }) => { const result = await tools.uploadReceipt(context, claimId, { filename, mimeType, bytes }); return { id: result.receiptId }; },
      updatePurpose: ({ claimId, value }) => tools.updatePurpose(context, claimId, value),
      updateFields: ({ claimId, fields }) => tools.updateFields(context, claimId, fields),
      readWorkbench: ({ claimId }) => tools.readWorkbench(context, claimId),
      deleteReceipt: ({ claimId, receiptId, expectedClaimVersion }) => tools.deleteReceipt(context, claimId, receiptId, expectedClaimVersion),
      deleteDraft: ({ claimId, expectedClaimVersion }) => tools.deleteDraft(context, claimId, expectedClaimVersion),
      listOwnedClaims: ({ limit }) => tools.listOwnedClaims(context, limit),
      searchOwnedClaims: ({ query }) => tools.searchOwnedClaims(context, query),
      findOwnedClaimByNumber: ({ claimNumber }) => tools.findOwnedClaimByNumber(context, claimNumber),
      readValidation: ({ claimId }) => tools.readValidation(context, claimId),
      readProgress: ({ claimId }) => tools.readProgress(context, claimId),
      prepareSubmission: async ({ claimId }) => { const result = await tools.prepareSubmission(context, claimId); return { token: result.confirmationToken, claimId: result.claimId, claimVersion: result.claimVersion, workbench: result.workbench }; },
      submitClaim: async ({ claimId, confirmationToken }) => tools.submit(context, claimId, confirmationToken),
    };
    const result = await runConversationTurn({ actorId, conversationId, channel: item.channel, chatType: item.chatType, message: turn.message, attachment: turn.attachment ? { ...turn.attachment, bytes: new Uint8Array([1, 2, 3]) } : undefined }, deps);
    observed.push({
      action, tools: calls.slice(before).map((call) => ({ name: call.name, claimId: typeof call.arguments.claimId === "string" ? call.arguments.claimId : undefined })),
      reply: result.reply, citationCount: result.citations.length,
      claimStates: Object.fromEntries([...claims.entries()].map(([id, entry]) => [id, { status: entry.claim.status, version: entry.claim.version, purpose: entry.claim.purpose }])),
      intakeStatus: result.intake?.status ?? null,
      ...(modelFailure ? { modelFailure } : {}),
    });
  }
  return observed;
}
