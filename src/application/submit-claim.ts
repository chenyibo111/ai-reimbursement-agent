import type { SubmissionDeps } from "@/src/application/request-submission";

export async function submitClaim(input: { actorId: string; claimId: string; confirmationToken: string }, deps: SubmissionDeps) {
  const confirmation = deps.tokens.read(input.confirmationToken);
  if (!confirmation || confirmation.claimId !== input.claimId) throw new Error("invalid confirmation");
  const claim = await deps.claims.get(input.claimId);
  if (claim.employeeId !== input.actorId) throw new Error("forbidden");
  if (confirmation.version !== claim.version) throw new Error("confirmation is stale");
  const issues = await deps.validate(input.actorId, input.claimId);
  if (issues.some((issue) => issue.severity === "BLOCKING")) throw new Error("claim has blocking validation issues");
  return deps.submissions.create({ claimId: claim.id, claimVersion: claim.version, totalAmountCents: claim.totalAmountCents });
}
