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

export type ChatModel = {
  decide(input: ChatModelInput): Promise<unknown>;
  classifyIntent?(message: string): Promise<AgentIntent>;
  answerPolicy?(input: PolicyAnswerInput): Promise<string>;
};
