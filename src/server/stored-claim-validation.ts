import { validateClaim, type ConfirmableField, type ValidationIssue } from "@/src/domain/claim-validation";
import type { ClaimStatus } from "@/src/domain/claim";

type ExtractedPayload = unknown;

export function validateStoredClaim(input: {
  status: ClaimStatus;
  purpose: string | null;
  expenseItems: Array<{ amountCents: number; amountSource: "EXTRACTED" | "USER_ENTERED" | "SYSTEM_CALCULATED"; issuedOn: Date | null; issuedOnSource: "EXTRACTED" | "USER_ENTERED" | "SYSTEM_CALCULATED" | null; invoiceNumber: string | null; invoiceSource: "EXTRACTED" | "USER_ENTERED" | "SYSTEM_CALCULATED" | null; receiptId: string | null }>;
  receipts: { id: string; extractionPayload: ExtractedPayload }[];
  validationResults: { code: string }[];
}): ValidationIssue[] {
  return validateClaim({
    status: input.status,
    purpose: input.purpose,
    expenseTotalCents: input.expenseItems.reduce((total, item) => total + item.amountCents, 0),
    duplicate: input.validationResults.length > 0,
    fields: confirmedOrExtractedFields(input.expenseItems, input.receipts),
  });
}

function confirmedOrExtractedFields(expenseItems: Parameters<typeof validateStoredClaim>[0]["expenseItems"], receipts: Parameters<typeof validateStoredClaim>[0]["receipts"]) {
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt.extractionPayload]));
  const fields: Partial<Record<"totalAmountCents" | "issuedOn" | "invoiceNumber", ConfirmableField>> = {};
  for (const item of expenseItems) {
    for (const name of ["totalAmountCents", "issuedOn", "invoiceNumber"] as const) {
      const candidate = employeeConfirmedField(item, name) ?? extractedField(receiptsById.get(item.receiptId ?? ""), name);
      if (!candidate) continue;
      const existing = fields[name];
      if (!existing || (candidate.source === "EXTRACTED" && candidate.confidence < existing.confidence)) fields[name] = candidate;
    }
  }
  const matchedReceiptIds = new Set(expenseItems.flatMap((item) => item.receiptId ? [item.receiptId] : []));
  for (const receipt of receipts) {
    if (matchedReceiptIds.has(receipt.id)) continue;
    for (const name of ["totalAmountCents", "issuedOn", "invoiceNumber"] as const) {
      const candidate = extractedField(receipt.extractionPayload, name);
      if (!candidate) continue;
      const existing = fields[name];
      if (!existing || (candidate.source === "EXTRACTED" && candidate.confidence < existing.confidence)) fields[name] = candidate;
    }
  }
  return fields;
}

function employeeConfirmedField(item: Parameters<typeof validateStoredClaim>[0]["expenseItems"][number], name: "totalAmountCents" | "issuedOn" | "invoiceNumber"): ConfirmableField | null {
  if (name === "totalAmountCents" && item.amountSource === "USER_ENTERED") return { value: item.amountCents, confidence: 1, source: "USER_ENTERED" };
  if (name === "issuedOn" && item.issuedOnSource === "USER_ENTERED") return { value: item.issuedOn?.toISOString().slice(0, 10) ?? null, confidence: 1, source: "USER_ENTERED" };
  if (name === "invoiceNumber" && item.invoiceSource === "USER_ENTERED") return { value: item.invoiceNumber, confidence: 1, source: "USER_ENTERED" };
  return null;
}

function extractedField(payload: ExtractedPayload | undefined, name: "totalAmountCents" | "issuedOn" | "invoiceNumber"): ConfirmableField | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const field = (payload as Record<string, unknown>)[name];
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const candidate = field as Record<string, unknown>;
  if ((typeof candidate.value !== "string" && typeof candidate.value !== "number" && candidate.value !== null) || typeof candidate.confidence !== "number" || candidate.source !== "EXTRACTED") return null;
  return { value: candidate.value, confidence: candidate.confidence, source: "EXTRACTED" };
}
