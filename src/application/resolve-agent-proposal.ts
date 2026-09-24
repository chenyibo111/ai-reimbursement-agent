export type ResolveAgentProposalInput = {
  actorId: string;
  claimId: string;
  proposalId: string;
  action: "ACCEPT" | "REJECT";
  expectedVersion: number;
};

export type ResolveAgentProposalDeps = {
  resolve(input: ResolveAgentProposalInput): Promise<{ proposal: { id: string; status: string }; version: number }>;
};

export async function resolveAgentProposal(input: ResolveAgentProposalInput, deps: ResolveAgentProposalDeps) {
  return deps.resolve(input);
}
