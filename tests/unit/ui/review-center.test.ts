import { expect, it } from "vitest";

import { availableReviewActions, employeeReceiptTaskLabel, reviewStatusLabel, type ReviewCaseDto } from "@/src/ui/review-center";

const ocrReview: ReviewCaseDto = {
  id: "review-1",
  kind: "RECEIPT_OCR",
  status: "OPEN",
  reasonCode: "OCR_LOW_CONFIDENCE",
  assignedReviewer: null,
  claim: { id: "claim-1", purpose: null, version: 0 },
  receipt: { id: "receipt-1", originalFilename: "住宿发票.pdf", status: "EXTRACTED" },
  policySource: null,
  job: { id: "job-1", kind: "RECEIPT_EXTRACTION", status: "REVIEW_REQUIRED", failureCode: "OCR_LOW_CONFIDENCE" },
};

it("offers reviewer actions only to the assigned reviewer and keeps policy retry admin-only", () => {
  expect(availableReviewActions(ocrReview, { id: "reviewer", role: "FINANCE_REVIEWER" })).toEqual(["CLAIM"]);
  const claimed = { ...ocrReview, status: "CLAIMED" as const, assignedReviewer: { id: "reviewer", displayName: "复核员" } };
  expect(availableReviewActions(claimed, { id: "other", role: "FINANCE_REVIEWER" })).toEqual([]);
  expect(availableReviewActions(claimed, { id: "reviewer", role: "FINANCE_REVIEWER" })).toEqual(["CONFIRM", "CORRECT_FIELDS", "REQUEST_INFORMATION", "CLOSE"]);
  expect(availableReviewActions({ ...ocrReview, kind: "POLICY_SYNC", policySource: { id: "source-1", title: "报销制度" } }, { id: "admin", role: "ADMIN" })).toEqual(["RETRY", "CLAIM"]);
});

it("uses employee-safe wording for queued and manually checked receipts", () => {
  expect(employeeReceiptTaskLabel("PENDING")).toBe("正在排队识别");
  expect(employeeReceiptTaskLabel("EXTRACTING")).toBe("正在识别票据信息");
  expect(employeeReceiptTaskLabel("REVIEW_REQUIRED")).toBe("正在进行人工核验");
  expect(reviewStatusLabel("CLAIMED")).toBe("复核处理中");
});
