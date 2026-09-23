import { recordAuditEvent, type AuditEventWriter } from "@/src/application/audit-event";
import type { Claim } from "@/src/domain/claim";
import { assertClaimOwner } from "@/src/server/authorization";

export type UpdateClaimFieldInput = {
  actorId: string;
  claimId: string;
  expectedVersion: number;
  field: "purpose";
  value: string;
};

export type UpdatedClaimField = Claim & {
  fields: { purpose: { value: string; source: "USER_ENTERED" } };
};

export type UpdateClaimFieldDeps = {
  claims: {
    getByIdOrThrow(id: string): Promise<Claim>;
    updateDraft(id: string, expectedVersion: number, patch: { purpose: string }): Promise<Claim>;
  };
  audit: AuditEventWriter;
};

export async function updateClaimField(input: UpdateClaimFieldInput, deps: UpdateClaimFieldDeps): Promise<UpdatedClaimField> {
  const claim = await deps.claims.getByIdOrThrow(input.claimId);
  assertClaimOwner(input.actorId, claim);
  if (!input.value.trim()) throw new Error("purpose is required");
  const updated = await deps.claims.updateDraft(input.claimId, input.expectedVersion, { purpose: input.value.trim() });
  await recordAuditEvent(
    { type: "CLAIM_FIELD_UPDATED", actorId: input.actorId, claimId: input.claimId, payload: { field: input.field, source: "USER_ENTERED", value: input.value.trim() } },
    deps.audit,
  );
  return { ...updated, fields: { purpose: { value: updated.purpose ?? "", source: "USER_ENTERED" } } };
}
