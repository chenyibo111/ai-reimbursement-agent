import { assertClaimOwner } from "@/src/server/authorization";
import { validateClaim, type ClaimForValidation, type ValidationIssue } from "@/src/domain/claim-validation";

export type ValidateClaimDeps = { claims: { getForValidation(claimId: string): Promise<ClaimForValidation & { employeeId: string }> } };

export async function validateClaimForActor(actorId: string, claimId: string, deps: ValidateClaimDeps): Promise<ValidationIssue[]> {
  const claim = await deps.claims.getForValidation(claimId);
  assertClaimOwner(actorId, claim);
  return validateClaim(claim);
}
