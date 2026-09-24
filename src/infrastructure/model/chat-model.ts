export type ChatModelInput = {
  message: string;
  claimId: string;
  summary: unknown;
  issues: unknown[];
};

export type ChatModel = {
  decide(input: ChatModelInput): Promise<unknown>;
};
