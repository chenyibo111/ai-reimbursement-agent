import { expect, it } from "vitest";

import { formatClaimProgress } from "@/src/application/claim-progress";
import type { ClaimProgressSnapshot } from "@/services/agent/src/ports/reimbursement-port";

const draft: ClaimProgressSnapshot = {
  claimId: "claim-1", claimNumber: "BX20261027-0001", status: "DRAFT", version: 2,
  submissionNumber: null, submittedAt: null, approval: "NOT_CONNECTED", payment: "NOT_CONNECTED",
  receipts: [], issues: [{ code: "PURPOSE_REQUIRED", message: "报销事由不能为空", severity: "BLOCKING" }],
};

it("explains a missing draft field using only Go validation facts", () => {
  const answer = formatClaimProgress(draft);
  expect(answer).toContain("BX20261027-0001");
  expect(answer).toContain("报销事由不能为空");
  expect(answer).toContain("对话中补充");
  expect(answer).toContain("当前系统未接入审批/付款进度");
});

it.each([
  [{ receiptId: "r1", filename: "invoice.pdf", status: "READY_FOR_OCR", reviewStatus: "NONE" }, "识别中"],
  [{ receiptId: "r1", filename: "invoice.pdf", status: "REVIEW_REQUIRED", reviewStatus: "PENDING" }, "等待人工复核"],
  [{ receiptId: "r1", filename: "invoice.pdf", status: "EXTRACTED", reviewStatus: "RESOLVED" }, "复核已处理"],
  [{ receiptId: "r1", filename: "invoice.pdf", status: "QUARANTINED", reviewStatus: "REUPLOAD_REQUIRED" }, "删除并重新上传"],
] as const)("describes real OCR and review state %#", (receipt, expected) => {
  expect(formatClaimProgress({ ...draft, receipts: [receipt], issues: [] })).toContain(expected);
});

it("shows a real submission number without inventing approval or payment", () => {
  const answer = formatClaimProgress({ ...draft, status: "SUBMITTED", submissionNumber: "RB20261027-0001", submittedAt: "2026-10-27T01:00:00Z", issues: [] });
  expect(answer).toContain("RB20261027-0001");
  expect(answer).toContain("当前系统未接入审批/付款进度");
  expect(answer).not.toContain("已批准");
  expect(answer).not.toContain("已付款");
});
