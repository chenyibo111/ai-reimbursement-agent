import { expect, it } from "vitest";

import { extractedReceiptField, lowConfidenceField, receiptDisplayName, receiptStatusLabel, type ClaimReceipt } from "@/src/ui/claim-types";

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

it("gives each uploaded receipt a stable name and a readable recognition status", () => {
  expect(receiptDisplayName({ id: "receipt-123456", originalFilename: null })).toBe("票据 #123456");
  expect(receiptDisplayName({ id: "receipt-123456", originalFilename: "  差旅发票.pdf  " })).toBe("差旅发票.pdf");
  expect(receiptStatusLabel("FAILED")).toBe("识别失败");
  expect(receiptStatusLabel("PENDING")).toBe("等待识别");
});

it("reads recognized values and confidence without inventing values for missing fields", () => {
  expect(extractedReceiptField(receipt, "invoiceNumber")).toEqual({ value: "INV-001", confidence: 0.88 });
  expect(extractedReceiptField(receipt, "totalAmountCents")).toBeNull();
});
