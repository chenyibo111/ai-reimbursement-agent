import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { buildConversationContext, type ConversationContext } from "@/src/application/build-conversation-context";
import { conversationCollectedFieldNames } from "@/src/domain/agent-conversation";
import type { ConversationAction, ConversationDecision } from "@/src/infrastructure/model/chat-model";

export const intentActions = ["POLICY_QUERY", "START_INTAKE", "COLLECT_FIELDS", "LIST_CLAIMS", "SEARCH_CLAIMS", "NEXT_CLAIMS_PAGE", "SELECT_EDIT_CLAIM", "DELETE_RECEIPT", "DELETE_DRAFT", "READ_CLAIM", "READ_RECEIPT_AMOUNT", "READ_SUBMISSION_SUMMARY", "READ_CLAIM_PROGRESS", "PREPARE_SUBMISSION", "HELP", "CLARIFY", "OUT_OF_SCOPE"] as const satisfies readonly ConversationAction[];

const expectedDecisionSchema = z.object({
  claimNumber: z.string().regex(/^BX\d{8}-\d{4,}$/).optional(),
  claimOrdinal: z.number().int().min(1).max(10).optional(),
  receiptOrdinal: z.number().int().min(1).max(100).optional(),
  targetReference: z.literal("CURRENT_INTAKE").optional(),
  clarificationReason: z.enum(["POLICY_OR_CLAIM", "START_OR_HELP", "MULTIPLE_ACTIONS", "UNCLEAR_REFERENCE", "OTHER"]).optional(),
  fields: z.object({
    purpose: z.string().min(1).optional(),
    expenseCategory: z.string().min(1).optional(),
    participants: z.array(z.string().min(1)).optional(),
    projectCode: z.string().min(1).optional(),
  }).strict().optional(),
  search: z.object({
    status: z.enum(["DRAFT", "SUBMITTED"]).optional(),
    period: z.enum(["THIS_MONTH", "LAST_MONTH"]).optional(),
    createdFrom: z.string().optional(),
    createdBefore: z.string().optional(),
    purposeContains: z.string().optional(),
    expenseCategory: z.string().optional(),
    minRequestedAmountCent: z.number().int().nonnegative().optional(),
    maxRequestedAmountCent: z.number().int().nonnegative().optional(),
    sort: z.enum(["created_desc", "created_asc", "amount_desc", "amount_asc"]).optional(),
    requestedCount: z.number().int().min(1).max(100).optional(),
    countOnly: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const intentCaseSchema = z.object({
  id: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1_000),
  history: z.array(z.object({
    role: z.enum(["USER", "ASSISTANT"]),
    channel: z.enum(["WEB", "FEISHU"]).optional(),
    text: z.string().trim().min(1).max(1_000),
  }).strict()).max(8),
  intakeStatus: z.enum(["COLLECTING", "READY_TO_SUBMIT", "SUBMITTED", "ABANDONED"]).nullable(),
  pendingFields: z.array(z.enum(conversationCollectedFieldNames)).max(conversationCollectedFieldNames.length).optional(),
  channel: z.enum(["WEB", "FEISHU"]),
  chatType: z.enum(["p2p", "group"]).optional(),
  expectedAction: z.enum(intentActions),
  expectedDecision: expectedDecisionSchema.optional(),
  provenance: z.enum(["synthetic", "self_test"]).optional(),
  acceptedActions: z.array(z.enum(intentActions)).max(4).optional(),
  riskTags: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
  restartPending: z.boolean().optional(),
}).strict().refine((value) => value.intakeStatus !== null || value.pendingFields === undefined, { message: "pendingFields requires an intake" });

export type IntentEvalCase = z.infer<typeof intentCaseSchema>;
export type IntentEvalResult = {
  id: string;
  expectedAction: ConversationAction;
  actualAction: ConversationAction | "ERROR";
  accepted: boolean;
  argumentMatch: boolean | null;
  targetReferenceMatch: boolean | null;
  riskTags: string[];
  latencyMs: number;
  failureType?: "MODEL_ERROR" | "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE";
};
type ActionMetrics = { support: number; precision: number; recall: number; f1: number };
export type IntentEvalReport = {
  total: number;
  byAction: Record<ConversationAction, ActionMetrics>;
  macroF1: number;
  confusion: Record<ConversationAction, Record<ConversationAction | "ERROR", number>>;
  outOfScopeRecall: number;
  dangerousPrepareFalsePositives: number;
  dangerousWriteTargetErrors: number;
  targetReferenceErrors: number;
  decisionAccuracy: number;
  clarificationRate: number;
  failureCount: number;
  averageLatencyMs: number;
  results: IntentEvalResult[];
};

export function parseIntentEvalDataset(text: string): IntentEvalCase[] {
  const seen = new Set<string>();
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`invalid intent case JSON at line ${index + 1}`); }
    const parsed = intentCaseSchema.parse(value);
    if (seen.has(parsed.id)) throw new Error(`duplicate intent case id: ${parsed.id}`);
    seen.add(parsed.id);
    return parsed;
  });
}

export async function evaluateIntent(
  cases: readonly IntentEvalCase[],
  decide: (context: ConversationContext) => Promise<ConversationDecision>,
): Promise<IntentEvalReport> {
  const results: IntentEvalResult[] = [];
  for (const item of cases) {
    const context = buildConversationContext({
      conversation: { summary: "", summaryThroughSequence: 0 },
      messages: [
        ...item.history.map((entry, index) => ({ sequence: index + 1, role: entry.role, channel: entry.channel ?? item.channel, text: entry.text })),
        { sequence: item.history.length + 1, role: "USER" as const, channel: item.channel, text: item.message },
      ],
      intake: item.intakeStatus ? { status: item.intakeStatus, claimId: null, collectedFields: {}, pendingFields: item.pendingFields ?? ["purpose"], restartRequestedAt: item.restartPending ? new Date() : null } : null,
      policyCitations: [],
    });
    const started = performance.now();
    try {
      const decision = await decide(context);
      if (!intentActions.includes(decision.action)) throw Object.assign(new Error("invalid action"), { code: "INVALID_RESPONSE" });
      const { action: _action, reply: _reply, ...argumentsOnly } = decision;
      const argumentMatch = item.expectedDecision ? isDeepStrictEqual(argumentsOnly, item.expectedDecision) : null;
      const actionMatch = decision.action === item.expectedAction || Boolean(item.acceptedActions?.includes(decision.action));
      const expectedTarget = targetReference(item.expectedDecision);
      const actualTarget = targetReference(decision);
      const targetReferenceMatch = compareTargetReference(expectedTarget, actualTarget, actionMatch, item.riskTags);
      results.push({ id: item.id, expectedAction: item.expectedAction, actualAction: decision.action, accepted: actionMatch && argumentMatch !== false, argumentMatch, targetReferenceMatch, riskTags: item.riskTags ?? [], latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const failureType = code === "TIMEOUT" || code === "UNAVAILABLE" || code === "INVALID_RESPONSE" ? code : "MODEL_ERROR";
      results.push({ id: item.id, expectedAction: item.expectedAction, actualAction: "ERROR", accepted: false, argumentMatch: item.expectedDecision ? false : null, targetReferenceMatch: null, riskTags: item.riskTags ?? [], latencyMs: Math.round(performance.now() - started), failureType });
    }
  }

  const confusion = Object.fromEntries(intentActions.map((expected) => [expected, Object.fromEntries([...intentActions, "ERROR"].map((actual) => [actual, 0]))])) as IntentEvalReport["confusion"];
  for (const result of results) confusion[result.expectedAction][result.actualAction] += 1;
  const byAction = Object.fromEntries(intentActions.map((action) => {
    const support = results.filter((result) => result.expectedAction === action).length;
    const truePositive = confusion[action][action];
    const predicted = results.filter((result) => result.actualAction === action).length;
    const precision = predicted ? truePositive / predicted : 0;
    const recall = support ? truePositive / support : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return [action, { support, precision, recall, f1 }];
  })) as IntentEvalReport["byAction"];
  const supported = intentActions.filter((action) => byAction[action].support > 0);
  const decisionsWithArguments = results.filter((result) => result.argumentMatch !== null);
  const targetActions: readonly ConversationAction[] = ["COLLECT_FIELDS", "SELECT_EDIT_CLAIM", "DELETE_RECEIPT", "DELETE_DRAFT", "PREPARE_SUBMISSION"];
  return {
    total: results.length,
    byAction,
    macroF1: supported.length ? supported.reduce((sum, action) => sum + byAction[action].f1, 0) / supported.length : 0,
    confusion,
    outOfScopeRecall: byAction.OUT_OF_SCOPE.recall,
    dangerousPrepareFalsePositives: results.filter((result) => result.riskTags.includes("unsafe_submit") && result.actualAction === "PREPARE_SUBMISSION").length,
    dangerousWriteTargetErrors: results.filter((result) => result.riskTags.includes("wrong_claim") && targetActions.includes(result.actualAction as ConversationAction) && !result.accepted).length,
    targetReferenceErrors: results.filter((result) => result.targetReferenceMatch === false).length,
    decisionAccuracy: decisionsWithArguments.length ? decisionsWithArguments.filter((result) => result.accepted).length / decisionsWithArguments.length : 0,
    clarificationRate: results.length ? results.filter((result) => result.actualAction === "CLARIFY").length / results.length : 0,
    failureCount: results.filter((result) => result.actualAction === "ERROR").length,
    averageLatencyMs: results.length ? results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length : 0,
    results,
  };
}

function targetReference(value: Partial<ConversationDecision> | undefined): object | null {
  if (!value) return null;
  const keys = ["claimNumber", "claimOrdinal", "receiptOrdinal", "targetReference"] as const;
  const target = Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  return Object.keys(target).length ? target : null;
}

function compareTargetReference(expected: object | null, actual: object | null, actionMatch: boolean, riskTags: string[] | undefined): boolean | null {
  if (!actual) return null;
  if (!expected) return riskTags?.includes("wrong_claim") ? false : null;
  return actionMatch && isDeepStrictEqual(actual, expected);
}
