import { expect, it } from "vitest";

import { formatReceiptExtractionNotification } from "@/src/application/format-receipt-extraction-notification";

const workspace = "https://reimbursement.example.test";

it("summarizes complete high-confidence OCR fields", () => {
  const message = formatReceiptExtractionNotification({
    publicAppUrl: workspace,
    claimId: "claim-1",
    jobStatus: "SUCCEEDED",
    extractionPayload: payload({ invoiceNumber: field("INV-001"), issuedOn: field("2026-09-28"), totalAmountCents: field(12345) }),
  });

  expect(message).toContain("票据识别完成");
  expect(message).toContain("发票号码：INV-001");
  expect(message).toContain("开票日期：2026-09-28");
  expect(message).toContain("价税合计：¥123.45");
  expect(message).toContain("/claims/claim-1");
});

it("lists missing and low-confidence key fields without treating them as confirmed", () => {
  const message = formatReceiptExtractionNotification({
    publicAppUrl: workspace,
    claimId: "claim-2",
    jobStatus: "REVIEW_REQUIRED",
    extractionPayload: payload({ invoiceNumber: field("26317000", 0.42), issuedOn: field(null, 0), totalAmountCents: field(null, 0) }),
  });

  expect(message).toContain("识别结果需要确认");
  expect(message).toContain("发票号码：待确认识别值 26317000");
  expect(message).toContain("开票日期：请补充或确认");
  expect(message).toContain("价税合计：请补充或确认");
  expect(message).toContain("已转人工复核");
  expect(message).not.toContain("卖方名称");
});

it("asks the employee to use the workspace when OCR has no usable payload", () => {
  const message = formatReceiptExtractionNotification({ publicAppUrl: workspace, claimId: "claim-3", jobStatus: "CLOSED", extractionPayload: null });

  expect(message).toContain("票据识别未完成");
  expect(message).toContain("/claims/claim-3");
});

function field(value: string | number | null, confidence = 0.98) {
  return { value, confidence, source: "EXTRACTED" };
}

function payload(fields: Partial<Record<"invoiceNumber" | "issuedOn" | "totalAmountCents", ReturnType<typeof field>>>) {
  return { receiptType: "INVOICE", ...fields };
}
