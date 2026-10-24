import type { ClaimSnapshot, ReceiptSnapshot, ValidationSnapshot } from "@/services/agent/src/ports/reimbursement-port";

type Workbench = { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] };
export type ClaimFactKind = "READ_CLAIM" | "READ_RECEIPT_AMOUNT" | "READ_SUBMISSION_SUMMARY";

export function formatClaimFacts(kind: ClaimFactKind, workbench: Workbench, validation?: ValidationSnapshot): string {
  const { claim, receipts } = workbench;
  const claimLabel = claim.claimNumber || claim.id;
  if (kind === "READ_CLAIM") {
    return `报销单 ${claimLabel}。申请报销总额：${money(claim.requestedAmountCent)}。票据价税合计：${money(claim.totalAmountCent, "待确认")}。两者不是同一个字段，请以工作台当前单据为准。`;
  }
  if (kind === "READ_RECEIPT_AMOUNT") {
    if (!receipts.length) return `报销单 ${claimLabel} 尚无票据，无法确认发票金额。`;
    const lead = receipts.length > 1 ? `报销单 ${claimLabel} 有 ${receipts.length} 张票据，请根据文件名或发票号码指定：` : `报销单 ${claimLabel} 的票据：`;
    return lead + receipts.map(receiptLine).join("；") + "。票据金额来自当前识别结果，并非申请报销总额。";
  }
  const issues = validation?.issues ?? [];
  const issueText = issues.length ? issues.map((issue) => `${issue.severity === "BLOCKING" ? "阻断" : "提醒"}：${issue.message}`).join("；") : "当前未返回校验问题";
  const receiptText = receipts.length ? receipts.map(receiptLine).join("；") : "尚无票据";
  return `报销单 ${claimLabel} 的只读摘要：报销事由：${claim.purpose || "未填写"}；申请报销总额：${money(claim.requestedAmountCent)}；票据价税合计：${money(claim.totalAmountCent, "待确认")}；票据 ${receipts.length} 张（${receiptText}）；提交条件：${issueText}。此摘要未申请提交确认，也未提交报销单。`;
}

function receiptLine(receipt: ReceiptSnapshot): string {
  const identity = [receipt.filename, receipt.invoiceNumber ? `发票号码 ${receipt.invoiceNumber}` : null].filter(Boolean).join("，");
  return `${identity}，价税合计：${money(receipt.totalAmountCent, "待确认")}（${statusLabel(receipt.status)}）`;
}

function money(cents: number | null | undefined, missing = "未填写"): string {
  return typeof cents === "number" && Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : missing;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { UPLOAD_PENDING: "等待上传完成", READY_FOR_OCR: "识别中", EXTRACTED: "识别完成", REVIEW_REQUIRED: "人工复核中", QUARANTINED: "票据不可用" };
  return labels[status] ?? "状态待确认";
}
