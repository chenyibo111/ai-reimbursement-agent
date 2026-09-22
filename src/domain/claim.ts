export const claimStatuses = [
  "DRAFT",
  "PROCESSING",
  "NEEDS_INFORMATION",
  "AWAITING_CONFIRMATION",
  "SUBMITTED",
] as const;

export type ClaimStatus = (typeof claimStatuses)[number];

export type Claim = {
  id: string;
  employeeId: string;
  status: ClaimStatus;
  purpose: string | null;
  version: number;
};

export function transitionClaim(
  claim: Pick<Claim, "status" | "purpose">,
  next: ClaimStatus,
): ClaimStatus {
  if (claim.status === "SUBMITTED") {
    throw new Error("submitted claims are immutable");
  }

  if (next === "AWAITING_CONFIRMATION" && !claim.purpose?.trim()) {
    throw new Error("purpose is required");
  }

  return next;
}
