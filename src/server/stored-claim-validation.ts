import { validateClaim, type ValidationIssue } from "@/src/domain/claim-validation";
import type { ClaimStatus } from "@/src/domain/claim";

type ExtractedPayload = unknown;

export function validateStoredClaim(input: {
  status: ClaimStatus;
  purpose: string | null;
  expenseItems: { amountCents: number }[];
  receipts: { extractionPayload: ExtractedPayload }[];
  validationResults: { code: string }[];
}): ValidationIssue[] {
  return validateClaim({
    status: input.status,
    purpose: input.purpose,
    expenseTotalCents: input.expenseItems.reduce((total, item) => total + item.amountCents, 0),
    duplicate: input.validationResults.length > 0,
    fields: extractedFields(input.receipts.map((receipt) => receipt.extractionPayload)),
  });
}

function extractedFields(payloads: ExtractedPayload[]) {
  const fields: Record<string, { value: string | number | null; confidence: number; source: "EXTRACTED" }> = {};
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    for (const name of ["totalAmountCents", "issuedOn", "invoiceNumber"] as const) {
      const field = (payload as Record<string, unknown>)[name];
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const candidate = field as Record<string, unknown>;
      if ((typeof candidate.value !== "string" && typeof candidate.value !== "number" && candidate.value !== null) || typeof candidate.confidence !== "number" || candidate.source !== "EXTRACTED") continue;
      const existing = fields[name];
      if (!existing || candidate.confidence < existing.confidence) fields[name] = { value: candidate.value, confidence: candidate.confidence, source: "EXTRACTED" };
    }
  }
  return fields;
}
