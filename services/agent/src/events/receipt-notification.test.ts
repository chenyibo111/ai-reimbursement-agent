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
