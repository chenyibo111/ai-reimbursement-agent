import { expect, it } from "vitest";

import { formatClaimFacts } from "@/src/application/format-claim-facts";

const claim = { id: "claim-1", claimNumber: "BX-001", version: 2, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 12345, totalAmountCent: 10155, currency: "CNY" as const, receiptCount: 1 };
const receipt = { id: "receipt-1", claimId: "claim-1", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.97, totalAmountCent: 10155 };

it("distinguishes the requested amount from an invoice's OCR amount", () => {
  const workbench = { claim, receipts: [receipt] };
  expect(formatClaimFacts("READ_CLAIM", workbench)).toContain("申请报销总额：¥123.45");
  expect(formatClaimFacts("READ_RECEIPT_AMOUNT", workbench)).toContain("价税合计：¥101.55");
});

it("lists each receipt rather than choosing an ambiguous current invoice", () => {
  const reply = formatClaimFacts("READ_RECEIPT_AMOUNT", { claim: { ...claim, receiptCount: 2 }, receipts: [receipt, { ...receipt, id: "receipt-2", filename: "second.pdf", invoiceNumber: "456", totalAmountCent: 2500 }] });
  expect(reply).toContain("invoice.pdf");
  expect(reply).toContain("second.pdf");
  expect(reply).toContain("¥101.55");
  expect(reply).toContain("¥25.00");
});

it("keeps unknown and review-pending amounts unknown instead of zero", () => {
  const reply = formatClaimFacts("READ_SUBMISSION_SUMMARY", { claim: { ...claim, requestedAmountCent: null, totalAmountCent: null }, receipts: [{ ...receipt, totalAmountCent: null, status: "REVIEW_REQUIRED" }] }, { claimId: "claim-1", claimVersion: 2, policyVersion: "p1", issues: [{ code: "AMOUNT_REQUIRED", severity: "BLOCKING", message: "请填写申请金额" }] });
  expect(reply).toContain("申请报销总额：未填写");
  expect(reply).toContain("票据价税合计：待确认");
  expect(reply).toContain("人工复核中");
  expect(reply).toContain("请填写申请金额");
  expect(reply).not.toContain("¥0.00");
});

it("labels a non-null review-pending amount as an unconfirmed OCR candidate", () => {
  const reply = formatClaimFacts("READ_RECEIPT_AMOUNT", { claim, receipts: [{ ...receipt, status: "REVIEW_REQUIRED", totalAmountCent: 50000 }] });
  expect(reply).toContain("OCR 候选金额：¥500.00");
  expect(reply).toContain("待人工复核，尚未确认");
  expect(reply).not.toContain("价税合计：¥500.00");
});

it("does not describe a partial recognized sum as the total of all receipts", () => {
  const workbench = { claim: { ...claim, receiptCount: 2 }, receipts: [receipt, { ...receipt, id: "receipt-2", status: "REVIEW_REQUIRED", totalAmountCent: 50000 }] };
  for (const kind of ["READ_CLAIM", "READ_SUBMISSION_SUMMARY"] as const) {
    const reply = formatClaimFacts(kind, workbench);
    expect(reply).toContain("已识别票据小计：¥101.55");
    expect(reply).toContain("另有 1 张票据金额待确认");
    expect(reply).not.toContain("票据价税合计：¥101.55");
  }
});

it("numbers receipts with duplicate filenames and missing invoice numbers", () => {
  const reply = formatClaimFacts("READ_RECEIPT_AMOUNT", { claim: { ...claim, receiptCount: 2 }, receipts: [
    { ...receipt, invoiceNumber: "", filename: "invoice.pdf" },
    { ...receipt, id: "receipt-2", invoiceNumber: "", filename: "invoice.pdf" },
  ] });
  expect(reply).toContain("第 1 张：invoice.pdf");
  expect(reply).toContain("第 2 张：invoice.pdf");
  expect(reply).toContain("请根据序号");
});

it("does not claim a submission was prepared when only formatting a summary", () => {
  const reply = formatClaimFacts("READ_SUBMISSION_SUMMARY", { claim, receipts: [receipt] }, { claimId: "claim-1", claimVersion: 2, policyVersion: "p1", issues: [] });
  expect(reply).toContain("只读摘要");
  expect(reply).not.toContain("确认提交");
});
