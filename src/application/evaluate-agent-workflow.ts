import { z } from "zod";

import { intentActions } from "@/src/application/evaluate-intent";
import type { ConversationDecision } from "@/src/infrastructure/model/chat-model";
import type { ReimbursementToolName } from "@/services/agent/src/tool-gateway/reimbursement-tools";

const toolNames = ["create_claim_draft", "create_upload_session", "finalize_receipt_upload", "delete_owned_receipt", "delete_owned_draft", "get_claim_workbench", "list_owned_claims", "search_owned_claims", "find_owned_claim_by_number", "update_claim_fields", "get_claim_validation", "get_owned_claim_progress", "request_submission_confirmation", "submit_claim"] as const satisfies readonly ReimbursementToolName[];
const claimSchema = z.object({
  id: z.string().min(1), ownerId: z.string().min(1), claimNumber: z.string().min(1),
  status: z.enum(["DRAFT", "SUBMITTED"]), version: z.number().int().positive(),
  purpose: z.string().nullable(), requestedAmountCent: z.number().int().nonnegative().nullable().optional(),
  totalAmountCent: z.number().int().nonnegative().nullable(),
  expenseCategory: z.string().optional(), participants: z.array(z.string()).optional(), projectCode: z.string().optional(),
  receipts: z.array(z.object({ id: z.string(), filename: z.string(), status: z.string(), invoiceNumber: z.string().default(""), ocrConfidence: z.number().default(0), totalAmountCent: z.number().int().nonnegative().nullable() }).strict()),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(["BLOCKING", "WARNING"]), message: z.string() }).strict()).optional(),
}).strict();
const decisionSchema = z.object({
  action: z.enum(intentActions), reply: z.string(),
  fields: z.object({ purpose: z.string().optional(), expenseCategory: z.string().optional(), participants: z.array(z.string()).optional(), projectCode: z.string().optional() }).strict().optional(),
  claimNumber: z.string().optional(), claimOrdinal: z.number().int().positive().optional(), receiptOrdinal: z.number().int().positive().optional(),
  targetReference: z.literal("CURRENT_INTAKE").optional(),
  clarificationReason: z.enum(["POLICY_OR_CLAIM", "START_OR_HELP", "MULTIPLE_ACTIONS", "UNCLEAR_REFERENCE", "OTHER"]).optional(),
  search: z.record(z.string(), z.unknown()).optional(),
}).strict();
const expectedToolSchema = z.object({ name: z.enum(toolNames), claimId: z.string().optional() }).strict();
const workflowCaseSchema = z.object({
  id: z.string().min(1).max(100), provenance: z.enum(["synthetic", "self_test", "employee_anonymized"]),
  channel: z.enum(["WEB", "FEISHU"]), chatType: z.enum(["p2p", "group"]).optional(),
  initial: z.object({
    claims: z.array(claimSchema), selectedReadClaimId: z.string().optional(), selectedEditClaimId: z.string().optional(),
    intake: z.object({ status: z.enum(["COLLECTING", "READY_TO_SUBMIT", "SUBMITTED", "ABANDONED"]), claimId: z.string().nullable(), collectedFields: z.record(z.string(), z.unknown()).optional(), pendingFields: z.array(z.string()).optional() }).strict().optional(),
    policy: z.object({ answer: z.string(), evidenceText: z.string(), citationTitle: z.string(), citationUrl: z.string() }).strict().optional(),
  }).strict(),
  turns: z.array(z.object({
    message: z.string().min(1), fixtureDecision: decisionSchema.optional(),
    attachment: z.object({ filename: z.string(), mimeType: z.string() }).strict().optional(),
    expect: z.object({
      action: z.enum([...intentActions, "CONFIRM_SUBMISSION", "CONFIRM_DELETE_RECEIPT", "CONFIRM_DELETE_DRAFT"] as const),
      tools: z.array(expectedToolSchema), replyIncludes: z.array(z.string()), replyExcludes: z.array(z.string()).optional(),
      citationCount: z.number().int().nonnegative().optional(),
      claim: z.object({ id: z.string(), status: z.string().optional(), version: z.number().int().optional(), purpose: z.string().nullable().optional() }).strict().optional(),
      intakeStatus: z.enum(["COLLECTING", "READY_TO_SUBMIT", "SUBMITTED", "ABANDONED"]).nullable().optional(),
    }).strict(),
  }).strict()).min(1),
}).strict();

export type AgentWorkflowCase = z.infer<typeof workflowCaseSchema>;
export type ObservedWorkflowTurn = {
  action: string; tools: Array<{ name: ReimbursementToolName; claimId?: string }>;
  reply: string; citationCount: number;
  claimStates: Record<string, { status: string; version: number; purpose: string | null }>;
  intakeStatus: string | null;
  modelFailure?: { stage: "decision" | "policy_answer"; code: "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE" | "OTHER" };
};
export type WorkflowFailure = "ACTION_MISMATCH" | "TOOL_CALL_MISMATCH" | "TOOL_TARGET_MISMATCH" | "REPLY_MISSING" | "REPLY_FORBIDDEN" | "CITATION_MISMATCH" | "CLAIM_STATE_MISMATCH" | "INTAKE_STATE_MISMATCH" | "MODEL_ERROR" | "REPLAY_ERROR";
export type AgentWorkflowReport = {
  totalCases: number; totalTurns: number; passedCases: number; passedTurns: number; passed: boolean; sampled: boolean;
  safetyErrors: number; modelErrors: number; provenanceCounts: Record<AgentWorkflowCase["provenance"], number>;
  results: Array<{ id: string; provenance: AgentWorkflowCase["provenance"]; passed: boolean; turns: Array<{ index: number; failures: WorkflowFailure[]; expectedAction?: string; actualAction?: string; actualToolNames?: ReimbursementToolName[]; modelFailure?: ObservedWorkflowTurn["modelFailure"]; missingReplyChecks?: number[] }> }>;
};

export function parseAgentWorkflowDataset(source: string): AgentWorkflowCase[] {
  const seen = new Set<string>();
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new Error(`invalid workflow JSON at line ${index + 1}`); }
    const item = workflowCaseSchema.parse(raw);
    if (seen.has(item.id)) throw new Error(`duplicate workflow id: ${item.id}`);
    seen.add(item.id);
    return item;
  });
}

export async function evaluateAgentWorkflows(cases: readonly AgentWorkflowCase[], replayCase: (item: AgentWorkflowCase) => Promise<ObservedWorkflowTurn[]>, sampled: boolean): Promise<AgentWorkflowReport> {
  const results: AgentWorkflowReport["results"] = [];
  let safetyErrors = 0;
  for (const item of cases) {
    let observed: ObservedWorkflowTurn[];
    try { observed = await replayCase(item); } catch { observed = []; }
    const turns = item.turns.map((turn, index) => {
      const actual = observed[index];
      if (!actual) return { index: index + 1, failures: ["REPLAY_ERROR"] as WorkflowFailure[] };
      const failures: WorkflowFailure[] = [];
      if (actual.modelFailure || actual.action === "MODEL_ERROR") failures.push("MODEL_ERROR");
      if (actual.action !== turn.expect.action) failures.push("ACTION_MISMATCH");
      if (actual.tools.length !== turn.expect.tools.length || actual.tools.some((tool, i) => tool.name !== turn.expect.tools[i]?.name || (turn.expect.tools[i]?.claimId !== undefined && tool.claimId !== turn.expect.tools[i]?.claimId))) failures.push("TOOL_CALL_MISMATCH");
      if (actual.tools.some((tool, i) => turn.expect.tools[i]?.claimId !== undefined && tool.claimId !== turn.expect.tools[i]?.claimId)) failures.push("TOOL_TARGET_MISMATCH");
      const missingReplyChecks = turn.expect.replyIncludes.flatMap((phrase, phraseIndex) => replyContains(actual.reply, phrase) ? [] : [phraseIndex + 1]);
      if (missingReplyChecks.length) failures.push("REPLY_MISSING");
      if (turn.expect.replyExcludes?.some((phrase) => actual.reply.includes(phrase))) failures.push("REPLY_FORBIDDEN");
      if (turn.expect.citationCount !== undefined && actual.citationCount !== turn.expect.citationCount) failures.push("CITATION_MISMATCH");
      if (turn.expect.claim) {
        const state = actual.claimStates[turn.expect.claim.id];
        if (!state || (turn.expect.claim.status !== undefined && state.status !== turn.expect.claim.status) || (turn.expect.claim.version !== undefined && state.version !== turn.expect.claim.version) || (turn.expect.claim.purpose !== undefined && state.purpose !== turn.expect.claim.purpose)) failures.push("CLAIM_STATE_MISMATCH");
      }
      if (turn.expect.intakeStatus !== undefined && actual.intakeStatus !== turn.expect.intakeStatus) failures.push("INTAKE_STATE_MISMATCH");
      const writes = new Set<ReimbursementToolName>(["create_claim_draft", "create_upload_session", "finalize_receipt_upload", "delete_owned_receipt", "delete_owned_draft", "update_claim_fields", "request_submission_confirmation", "submit_claim"]);
      const unexpectedWrite = actual.tools.some((tool, i) => writes.has(tool.name) && (turn.expect.tools[i]?.name !== tool.name || (turn.expect.tools[i]?.claimId !== undefined && turn.expect.tools[i]?.claimId !== tool.claimId)));
      const unexpectedSubmission = turn.expect.claim?.status === "DRAFT" && actual.claimStates[turn.expect.claim.id]?.status === "SUBMITTED";
      if (failures.includes("TOOL_TARGET_MISMATCH") || unexpectedWrite || unexpectedSubmission) safetyErrors++;
      return { index: index + 1, failures, ...(failures.length ? { expectedAction: turn.expect.action, actualAction: actual.action, actualToolNames: actual.tools.map((tool) => tool.name) } : {}), ...(actual.modelFailure ? { modelFailure: actual.modelFailure } : {}), ...(missingReplyChecks.length ? { missingReplyChecks } : {}) };
    });
    results.push({ id: item.id, provenance: item.provenance, passed: turns.every((turn) => !turn.failures.length), turns });
  }
  const totalTurns = results.reduce((sum, item) => sum + item.turns.length, 0);
  const passedTurns = results.reduce((sum, item) => sum + item.turns.filter((turn) => !turn.failures.length).length, 0);
  return {
    totalCases: cases.length, totalTurns, passedCases: results.filter((item) => item.passed).length, passedTurns,
    passed: passedTurns === totalTurns && totalTurns > 0, sampled,
    safetyErrors,
    modelErrors: results.reduce((sum, item) => sum + item.turns.filter((turn) => turn.failures.includes("MODEL_ERROR")).length, 0),
    provenanceCounts: { synthetic: cases.filter((item) => item.provenance === "synthetic").length, self_test: cases.filter((item) => item.provenance === "self_test").length, employee_anonymized: cases.filter((item) => item.provenance === "employee_anonymized").length },
    results,
  };
}

export function fixtureDecision(turn: AgentWorkflowCase["turns"][number]): ConversationDecision {
  if (!turn.fixtureDecision) throw new Error("fixture decision is required for this turn");
  return turn.fixtureDecision as ConversationDecision;
}

function replyContains(reply: string, expected: string): boolean {
  const normalizeAmountSpacing = (text: string) => text.replace(/(\d)\s+元/g, "$1元");
  return normalizeAmountSpacing(reply).includes(normalizeAmountSpacing(expected));
}
