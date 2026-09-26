import { expect, it } from "vitest";

import { validateStoredClaimWithPolicy } from "@/src/application/validate-policy-claim";

it("combines base validation with the current published policy without inventing policy issues when none is published", () => {
  const claim = {
    status: "DRAFT" as const,
    purpose: "客户拜访",
    expenseItems: [{ amountCents: 120_000, amountSource: "USER_ENTERED" as const, issuedOn: null, issuedOnSource: null, invoiceNumber: "INV-1", invoiceSource: "USER_ENTERED" as const, receiptId: null, expenseCategory: "交通", participants: null, projectCode: null }],
    receipts: [],
    validationResults: [],
  };

  expect(validateStoredClaimWithPolicy(claim, null)).toEqual([]);
  expect(validateStoredClaimWithPolicy(claim, {
    id: "policy-1",
    rules: [{ code: "TOTAL", name: "总额上限", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", config: { maxAmountCents: 100_000 }, enabled: true, sortOrder: 0 }],
  })).toEqual([expect.objectContaining({ code: "POLICY_TOTAL", policyVersionId: "policy-1" })]);
});
