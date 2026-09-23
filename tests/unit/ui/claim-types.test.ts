import { expect, it } from "vitest";

import { lowConfidenceField, type ClaimReceipt } from "@/src/ui/claim-types";

const receipt: ClaimReceipt = {
  id: "receipt-1",
  status: "EXTRACTED",
  receiptType: "VAT",
  extractionPayload: {
    invoiceNumber: { value: "INV-001", source: "EXTRACTED", confidence: 0.88 },
    issuedOn: { value: "2026-09-20", source: "EXTRACTED", confidence: 0.99 },
  },
};

it("identifies only the extracted fields that still need employee confirmation", () => {
  expect(lowConfidenceField(receipt, "invoiceNumber")).toBe(true);
  expect(lowConfidenceField(receipt, "issuedOn")).toBe(false);
  expect(lowConfidenceField(receipt, "totalAmountCents")).toBe(false);
});
