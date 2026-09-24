import { expect, it } from "vitest";

import { extractReceipt } from "@/src/application/extract-receipt";

it("does not double count a matching upload with a duplicate content hash", async () => {
  const saved: { payload?: unknown; validation?: unknown; expense?: unknown } = {};
  const result = await extractReceipt(
    { actorId: "employee-1", claimId: "claim-1", receiptId: "receipt-2" },
    {
      claims: { getByIdOrThrow: async () => ({ employeeId: "employee-1" }) },
      receipts: {
        getByIdOrThrow: async () => ({
          id: "receipt-2", claimId: "claim-1", employeeId: "employee-1", objectKey: "claims/claim-1/receipt-2", mimeType: "application/pdf", contentHash: "same-hash",
        }),
        markExtracted: async (input) => { saved.payload = input.payload; },
        markFailed: async () => undefined,
        hasDuplicateContentHash: async () => true,
        hasSubmittedInvoiceNumber: async () => false,
      },
      expenses: { create: async (input) => { saved.expense = input; } },
      validations: { create: async (input) => { saved.validation = input; } },
      provider: { extract: async () => fixtureExtraction() },
      audit: { append: async () => undefined },
    },
  );

  expect(result).toEqual({ receiptId: "receipt-2", expenseItemCreated: false, validationIssues: [{ code: "DUPLICATE_FILE", severity: "BLOCKING" }] });
  expect(saved.payload).toEqual(expect.objectContaining({ receiptType: "VAT_INVOICE" }));
  expect(saved.expense).toBeUndefined();
  expect(saved.validation).toEqual(expect.objectContaining({ code: "DUPLICATE_FILE", severity: "BLOCKING" }));
});

it("marks the retained receipt as failed when OCR is unavailable", async () => {
  let failedReceiptId: string | undefined;

  await expect(
    extractReceipt(
      { actorId: "employee-1", claimId: "claim-1", receiptId: "receipt-1" },
      {
        claims: { getByIdOrThrow: async () => ({ employeeId: "employee-1" }) },
        receipts: {
          getByIdOrThrow: async () => ({
            id: "receipt-1", claimId: "claim-1", employeeId: "employee-1", objectKey: "claims/claim-1/receipt-1", mimeType: "image/png", contentHash: "hash",
          }),
          markExtracted: async () => undefined,
          markFailed: async ({ receiptId }) => { failedReceiptId = receiptId; },
          hasDuplicateContentHash: async () => false,
          hasSubmittedInvoiceNumber: async () => false,
        },
        expenses: { create: async () => undefined },
        validations: { create: async () => undefined },
        provider: { extract: async () => { throw new Error("OCR service request failed"); } },
        audit: { append: async () => undefined },
      },
    ),
  ).rejects.toThrow("OCR service request failed");

  expect(failedReceiptId).toBe("receipt-1");
});

function fixtureExtraction() {
  return {
    receiptType: "VAT_INVOICE",
    invoiceNumber: { value: "INV-001", confidence: 0.99, source: "EXTRACTED" as const },
    issuedOn: { value: "2026-09-20", confidence: 0.99, source: "EXTRACTED" as const },
    totalAmountCents: { value: 38600, confidence: 0.99, source: "EXTRACTED" as const },
    taxAmountCents: { value: 2100, confidence: 0.99, source: "EXTRACTED" as const },
    sellerName: { value: "测试商户", confidence: 0.99, source: "EXTRACTED" as const },
  };
}
