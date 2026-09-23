export type SubmissionClaim = { id: string; employeeId: string; version: number; purpose: string | null; totalAmountCents: number; receiptCount: number };
export type SubmissionIssue = { code: string; severity: "BLOCKING" | "WARNING" };
export type SubmissionPreview = { token: string; claimId: string; claimVersion: number; totalAmountCents: number; receiptCount: number; purpose: string | null; issues: SubmissionIssue[] };
export type SubmissionDeps = {
  claims: { get(claimId: string): Promise<SubmissionClaim> };
  validate(actorId: string, claimId: string): Promise<SubmissionIssue[]>;
  tokens: { create(input: { claimId: string; version: number }): string; read(token: string): { claimId: string; version: number } | null };
  submissions: { create(input: { claimId: string; claimVersion: number; totalAmountCents: number }): Promise<{ submissionNumber: string }> };
};

export async function requestSubmission(input: { actorId: string; claimId: string }, deps: SubmissionDeps): Promise<SubmissionPreview> {
  const claim = await deps.claims.get(input.claimId);
  if (claim.employeeId !== input.actorId) throw new Error("forbidden");
  const issues = await deps.validate(input.actorId, input.claimId);
  if (issues.some((issue) => issue.severity === "BLOCKING")) throw new Error("claim has blocking validation issues");
  return { token: deps.tokens.create({ claimId: claim.id, version: claim.version }), claimId: claim.id, claimVersion: claim.version, totalAmountCents: claim.totalAmountCents, receiptCount: claim.receiptCount, purpose: claim.purpose, issues };
}
