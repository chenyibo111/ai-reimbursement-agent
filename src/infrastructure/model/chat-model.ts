export type ChatModelInput = {
  message: string;
  claimId: string;
  summary: unknown;
  issues: unknown[];
};

export type AgentIntent = "POLICY_QUERY" | "CLAIM_ACTION" | "OTHER";

export type PolicyAnswerInput = {
  question: string;
  sources: Array<{
    title: string;
    excerpt: string;
    headingPath: string[];
  }>;
};

export type ConversationAction = "POLICY_QUERY" | "START_INTAKE" | "COLLECT_FIELDS" | "LIST_CLAIMS" | "SEARCH_CLAIMS" | "NEXT_CLAIMS_PAGE" | "SELECT_EDIT_CLAIM" | "DELETE_RECEIPT" | "READ_CLAIM" | "READ_RECEIPT_AMOUNT" | "READ_SUBMISSION_SUMMARY" | "PREPARE_SUBMISSION" | "HELP" | "CLARIFY" | "OUT_OF_SCOPE";

export type ConversationDecision = {
  action: ConversationAction;
  reply: string;
  fields?: import("@/services/agent/src/ports/reimbursement-port").ClaimFieldPatch;
  claimNumber?: string;
  claimOrdinal?: number;
  receiptOrdinal?: number;
  search?: import("@/src/application/claim-search").ClaimSearchRequest;
  targetReference?: "CURRENT_INTAKE";
  clarificationReason?: "POLICY_OR_CLAIM" | "START_OR_HELP" | "MULTIPLE_ACTIONS" | "UNCLEAR_REFERENCE" | "OTHER";
};

export type ChatModel = {
  decide(input: ChatModelInput): Promise<unknown>;
  classifyIntent?(message: string): Promise<AgentIntent>;
  answerPolicy?(input: PolicyAnswerInput): Promise<string>;
  decideConversation?(input: ConversationContext): Promise<ConversationDecision>;
};
import type { ConversationContext } from "@/src/application/build-conversation-context";
import type { ConversationCollectedFieldName } from "@/src/domain/agent-conversation";
