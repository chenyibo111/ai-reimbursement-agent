import { evaluatePolicyRules, type PolicyValidationIssue } from "@/src/domain/policy-rule-engine";
import type { ClaimStatus } from "@/src/domain/claim";
import { validateStoredClaim } from "@/src/server/stored-claim-validation";

type StoredPolicyClaim = {
  status: ClaimStatus;
  purpose: string | null;
  expenseItems: Array<{ id?: string; amountCents: number; amountSource: "EXTRACTED" | "USER_ENTERED" | "SYSTEM_CALCULATED"; issuedOn: Date | null; issuedOnSource: "EXTRACTED" | "USER_ENTERED" | "SYSTEM_CALCULATED" | null; invoiceNumber: string | null; invoiceSource: "EXTRACTED" | "USER_ENTERED" | "SYSTEM_CALCULATED" | null; receiptId: string | null; expenseCategory: string | null; participants: string | null; projectCode: string | null }>;
  receipts: { id: string; extractionPayload: unknown }[];
  validationResults: { code: string }[];
};

type PublishedPolicy = {
  id: string;
  rules: Array<{ code: string; name: string; type: "CLAIM_TOTAL_MAX" | "CATEGORY_ITEM_MAX" | "CATEGORY_ALLOWED" | "CATEGORY_REQUIRED_FIELD"; severity: "BLOCKING" | "WARNING"; config: unknown; enabled: boolean; sortOrder: number }>;
};

export function validateStoredClaimWithPolicy(input: StoredPolicyClaim, policy: PublishedPolicy | null): Array<{ code: string; severity: "BLOCKING" | "WARNING" } | PolicyValidationIssue> {
  const base = validateStoredClaim(input);
  if (!policy) return base;
  return [...base, ...evaluatePolicyRules({
    policyVersionId: policy.id,
    rules: policy.rules.filter((rule) => rule.enabled),
    claim: {
      totalAmountCents: input.expenseItems.reduce((total, item) => total + item.amountCents, 0),
      expenseItems: input.expenseItems.map((item, index) => ({ id: item.id ?? `expense-${index + 1}`, amountCents: item.amountCents, expenseCategory: item.expenseCategory, participants: item.participants, projectCode: item.projectCode })),
    },
  })];
}
