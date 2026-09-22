import type { Claim, ClaimStatus } from "@/src/domain/claim";
import { recordAuditEvent, type AuditEventWriter } from "@/src/application/audit-event";

export type CreateClaimDraftInput = {
  actorId: string;
  purpose?: string;
};

export type CreateClaimDeps = {
  claims: {
    create(input: { employeeId: string; purpose: string | null; status: ClaimStatus }): Promise<Claim>;
  };
  audit: AuditEventWriter;
};

export async function createClaimDraft(input: CreateClaimDraftInput, deps: CreateClaimDeps): Promise<Claim> {
  const claim = await deps.claims.create({
    employeeId: input.actorId,
    purpose: input.purpose?.trim() || null,
    status: "DRAFT",
  });

  await recordAuditEvent(
    { type: "CLAIM_CREATED", actorId: input.actorId, claimId: claim.id, payload: {} },
    deps.audit,
  );

  return claim;
}
