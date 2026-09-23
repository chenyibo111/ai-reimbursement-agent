import { expect, it } from "vitest";

import { validateClaim } from "@/src/domain/claim-validation";

it("requires confirmation for a low-confidence extracted total amount", () => {
  const issues = validateClaim({
    status: "AWAITING_CONFIRMATION",
    purpose: "客户午餐",
    expenseTotalCents: 38600,
    duplicate: false,
    fields: {
      totalAmountCents: { value: 38600, confidence: 0.62, source: "EXTRACTED" },
      issuedOn: { value: "2026-09-20", confidence: 0.99, source: "EXTRACTED" },
      invoiceNumber: { value: "INV-001", confidence: 0.99, source: "EXTRACTED" },
    },
  });

  expect(issues).toContainEqual({ code: "CONFIRM_TOTAL_AMOUNT", severity: "BLOCKING" });
});

it("blocks missing purpose, zero amount, duplicate invoices, and submitted claims", () => {
  const issues = validateClaim({
    status: "SUBMITTED",
    purpose: null,
    expenseTotalCents: 0,
    duplicate: true,
    fields: {},
  });

  expect(issues).toEqual(
    expect.arrayContaining([
      { code: "PURPOSE_REQUIRED", severity: "BLOCKING" },
      { code: "EXPENSE_REQUIRED", severity: "BLOCKING" },
      { code: "DUPLICATE_RECEIPT", severity: "BLOCKING" },
      { code: "CLAIM_ALREADY_SUBMITTED", severity: "BLOCKING" },
    ]),
  );
});
