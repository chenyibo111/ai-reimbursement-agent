import type { Claim, ClaimStatus } from "@/src/domain/claim";
import { assertClaimOwner } from "@/src/server/authorization";

export type ClaimSummary = {
  id: string;
  employeeId: string;
  status: ClaimStatus;
  version: number;
  purpose: string | null;
  totalAmountCents: number;
  receipts: Array<Record<string, unknown>>;
  expenseItems: Array<Record<string, unknown>>;
  validationResults: Array<Record<string, unknown>>;
  agentProposals: Array<{
    id: string;
    target: string;
    field: string;
    displayValue: string;
    targetLabel: string;
    currentValue: string;
    reason: string;
    status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
    claimVersion: number;
    createdAt: string;
    resolvedAt: string | null;
  }>;
};

export type ClaimSummaryDeps = {
  claims: {
    getByIdOrThrow(id: string): Promise<Claim>;
    toSummary(id: string): Promise<ClaimSummary>;
  };
};

export async function getClaimSummary(
  actorId: string,
  claimId: string,
  deps: ClaimSummaryDeps,
): Promise<ClaimSummary> {
  const claim = await deps.claims.getByIdOrThrow(claimId);
  assertClaimOwner(actorId, claim);
  return deps.claims.toSummary(claimId);
}
