import { expect, it } from "vitest";

import { formatReceiptExtractionEventNotification } from "./receipt-notification";

it("formats a safe OCR completion notification from the refetched workbench", () => {
  const message = formatReceiptExtractionEventNotification({
    publicAppUrl: "https://reimbursement.example.test",
    claimId: "claim-1",
    workbench: {
      receipts: [{ id: "receipt-1", filename: "hotel.pdf", status: "EXTRACTED", invoiceNumber: "INV-001", ocrConfidence: 0.98 }],
    },
  });

  expect(message).toContain("票据识别完成");
  expect(message).toContain("发票号码：INV-001");
  expect(message).toContain("识别置信度：98%");
  expect(message).toContain("/claims/claim-1");
  expect(message).not.toContain("objectKey");
});

it("asks the employee to review a non-final OCR result", () => {
  const message = formatReceiptExtractionEventNotification({
    publicAppUrl: "https://reimbursement.example.test",
    claimId: "claim-2",
    workbench: {
      receipts: [{ id: "receipt-2", filename: "hotel.pdf", status: "REVIEW_REQUIRED", invoiceNumber: "", ocrConfidence: 0 }],
    },
  });

  expect(message).toContain("需要人工复核");
  expect(message).toContain("/claims/claim-2");
});

it("names taxi and dining suggestions without claiming they are confirmed", () => {
  const message = formatReceiptExtractionEventNotification({ publicAppUrl: "https://reimbursement.example.test", claimId: "claim-mixed", receiptId: "taxi", workbench: {
    claim: { itemizationMode: "ITEMIZED", expenseItemTotalAmountCent: 9000, expenseItems: [
      { receiptId: "taxi", receiptType: "TAXI", expenseCategory: "市内交通费", categorySource: "MODEL", amountCent: 3800 },
      { receiptId: "dining", receiptType: "DINING", expenseCategory: "餐饮费", categorySource: "MODEL", amountCent: 5200 },
    ] },
    receipts: [{ id: "taxi", filename: "taxi.pdf", status: "EXTRACTED", invoiceNumber: "TAXI-1", ocrConfidence: 0.98 }, { id: "dining", filename: "dining.pdf", status: "EXTRACTED", invoiceNumber: "DINING-1", ocrConfidence: 0.97 }],
  } });
  expect(message).toContain("打车");
  expect(message).toContain("餐饮");
  expect(message).toContain("AI 建议类别");
  expect(message).toContain("明细合计：¥90.00");
  expect(message).toContain("不代表费用类别或报销政策已获确认");
});
