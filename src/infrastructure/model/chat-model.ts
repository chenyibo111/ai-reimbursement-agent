export type ChatModel = {
  decide(input: { message: string; claimId: string; summary: unknown; issues: unknown[] }): Promise<unknown>;
};
