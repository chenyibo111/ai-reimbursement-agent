import { expect, it } from "vitest";

import { extractedReceiptField, formatPolicyEvidence, hasBlockingValidation, lowConfidenceField, receiptDisplayName, receiptStatusLabel, type ClaimReceipt } from "@/src/ui/claim-types";

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
  expect(receiptStatusLabel("REVIEW_REQUIRED")).toBe("人工核验中");
});

it("reads recognized values and confidence without inventing values for missing fields", () => {
  expect(extractedReceiptField(receipt, "invoiceNumber")).toEqual({ value: "INV-001", confidence: 0.88 });
  expect(extractedReceiptField(receipt, "totalAmountCents")).toBeNull();
});

it("marks a submission as blocked only when the server reports a blocking validation", () => {
  expect(hasBlockingValidation([{ code: "DUPLICATE_RECEIPT", severity: "BLOCKING", message: "发现重复票据" }])).toBe(true);
  expect(hasBlockingValidation([{ code: "MANUAL_REVIEW", severity: "WARNING", message: "建议核对" }])).toBe(false);
});

it("formats a policy evidence item with its exact section and retrieval score", () => {
  expect(formatPolicyEvidence({
    id: "chunk-1",
    title: "差旅制度",
    url: "https://example.test/docx/1#住宿",
    excerpt: "一线城市住宿上限为每晚 500 元。",
    headingPath: ["差旅费用", "住宿标准"],
    score: 0.906,
  })).toEqual({
    sourceLabel: "差旅制度 · 差旅费用 > 住宿标准",
    scoreLabel: "检索相关度 91%",
    excerpt: "一线城市住宿上限为每晚 500 元。",
  });
});
