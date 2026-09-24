import { expect, it } from "vitest";

import { buildAgentContext } from "@/src/application/build-agent-context";

it("creates public target references without leaking private receipt data", () => {
  const context = buildAgentContext({
    claim: {
      id: "claim-private-id",
      version: 4,
      purpose: null,
      totalAmountCents: 12_345,
      expenseItems: [
        { id: "expense-private-id", receiptId: "receipt-private-id", amountCents: 12_345, invoiceNumber: "INV-1", issuedOn: "2026-09-24" },
      ],
      receipts: [{ id: "receipt-private-id", objectKey: "claims/secret.pdf", extractionPayload: { invoiceNumber: { value: "INV-1", confidence: 0.5, source: "EXTRACTED" } } }],
    },
    issues: [{ code: "PURPOSE_REQUIRED", severity: "BLOCKING" }, { code: "CONFIRM_INVOICE_NUMBER", severity: "BLOCKING" }],
  });

  expect(context.summary).toMatchObject({ purpose: null, expenses: [{ target: "expense-1", amountCents: 12_345 }] });
  expect(context.allowedTargets).toEqual(expect.arrayContaining([
    { target: "claim", fields: ["purpose"] },
    { target: "expense-1", fields: ["invoiceNumber"] },
  ]));
  expect(JSON.stringify({ summary: context.summary, allowedTargets: context.allowedTargets })).not.toContain("private-id");
  expect(JSON.stringify({ summary: context.summary, allowedTargets: context.allowedTargets })).not.toContain("claims/secret.pdf");
  expect(context.targetMap["expense-1"]).toEqual({ expenseItemId: "expense-private-id" });
});
