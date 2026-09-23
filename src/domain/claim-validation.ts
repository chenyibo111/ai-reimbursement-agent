import type { ClaimStatus } from "@/src/domain/claim";

export type ValidationIssue = {
  code: string;
  severity: "BLOCKING" | "WARNING";
};

export type ConfirmableField = {
  value: string | number | null;
  confidence: number;
  source: "EXTRACTED" | "USER_ENTERED";
};

export type ClaimForValidation = {
  status: ClaimStatus;
  purpose: string | null;
  expenseTotalCents: number;
  duplicate: boolean;
  fields: Partial<Record<"totalAmountCents" | "issuedOn" | "invoiceNumber", ConfirmableField>>;
};

export function validateClaim(claim: ClaimForValidation): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!claim.purpose?.trim()) issues.push({ code: "PURPOSE_REQUIRED", severity: "BLOCKING" });
  if (claim.expenseTotalCents <= 0) issues.push({ code: "EXPENSE_REQUIRED", severity: "BLOCKING" });
  if (claim.duplicate) issues.push({ code: "DUPLICATE_RECEIPT", severity: "BLOCKING" });
  if (claim.status === "SUBMITTED") issues.push({ code: "CLAIM_ALREADY_SUBMITTED", severity: "BLOCKING" });

  for (const [field, issueCode] of [
    ["totalAmountCents", "CONFIRM_TOTAL_AMOUNT"],
    ["issuedOn", "CONFIRM_ISSUED_ON"],
    ["invoiceNumber", "CONFIRM_INVOICE_NUMBER"],
  ] as const) {
    const value = claim.fields[field];
    if (value?.source === "EXTRACTED" && value.confidence < 0.9) {
      issues.push({ code: issueCode, severity: "BLOCKING" });
    }
  }

  return issues;
}
