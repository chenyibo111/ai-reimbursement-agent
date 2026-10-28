import type { ClaimSnapshot, ReceiptSnapshot } from "@/services/agent/src/ports/reimbursement-port";
import { readClaimSearchState } from "@/src/application/claim-search";

export type EditTargetReference = { claimNumber?: string; claimOrdinal?: number };

export async function selectOwnedEditClaim(input: {
  actorId: string;
  reference: EditTargetReference;
  searchState: unknown;
  findOwnedClaimByNumber?: (input: { actorId: string; claimNumber: string }) => Promise<ClaimSnapshot | null>;
  readWorkbench?: (input: { actorId: string; claimId: string }) => Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>;
}): Promise<ClaimSnapshot | null> {
  if (!input.readWorkbench) return null;
  let claimId: string | null = null;
  if (input.reference.claimNumber) {
    if (!/^BX[0-9]{8}-[0-9]{4,}$/.test(input.reference.claimNumber) || !input.findOwnedClaimByNumber) return null;
    const found = await input.findOwnedClaimByNumber({ actorId: input.actorId, claimNumber: input.reference.claimNumber });
    claimId = found?.id ?? null;
  } else if (input.reference.claimOrdinal) {
    const state = readClaimSearchState(input.searchState, new Date());
    claimId = state?.lastPage.find((item) => item.ordinal === input.reference.claimOrdinal)?.id ?? null;
  }
  if (!claimId) return null;
  const workbench = await input.readWorkbench({ actorId: input.actorId, claimId });
  return workbench.claim.id === claimId && workbench.claim.status === "DRAFT" ? workbench.claim : null;
}

export function writeTargetIsAmbiguous(input: {
  intakeClaimId: string | null | undefined;
  selectedReadClaimId: string | null;
  selectedEditClaimId: string | null;
  targetReference?: "CURRENT_INTAKE";
}): boolean {
  if (input.targetReference === "CURRENT_INTAKE") return false;
  const writeClaimId = input.selectedEditClaimId ?? input.intakeClaimId;
  return Boolean(input.selectedReadClaimId && writeClaimId && input.selectedReadClaimId !== writeClaimId);
}

export async function resolveSelectedDraft(input: {
  actorId: string;
  claimId: string;
  readWorkbench?: (input: { actorId: string; claimId: string }) => Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>;
}): Promise<ClaimSnapshot | null> {
  if (!input.readWorkbench) return null;
  const workbench = await input.readWorkbench({ actorId: input.actorId, claimId: input.claimId });
  return workbench.claim.id === input.claimId && workbench.claim.status === "DRAFT" ? workbench.claim : null;
}
