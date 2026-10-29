import type { ClaimSnapshot, ReceiptSnapshot, ValidationSnapshot } from "@/services/agent/src/ports/reimbursement-port";

type Workbench = { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] };
export type ClaimFactKind = "READ_CLAIM" | "READ_RECEIPT_AMOUNT" | "READ_SUBMISSION_SUMMARY";

export function formatClaimFacts(kind: ClaimFactKind, workbench: Workbench, validation?: ValidationSnapshot): string {
  const { claim, receipts } = workbench;
  const claimLabel = claim.claimNumber || claim.id;
  const receiptTotal = receiptTotalDescription(workbench);
  if (kind === "READ_CLAIM") {
    return `报销单 ${claimLabel}，状态：${claim.status === "DRAFT" ? "草稿" : claim.status === "SUBMITTED" ? "已提交" : "待确认"}，报销事由：${claim.purpose || "未填写"}。申请报销总额：${money(claim.requestedAmountCent)}。${receiptTotal}。两者不是同一个字段，请以工作台当前单据为准。`;
  }
  if (kind === "READ_RECEIPT_AMOUNT") {
    if (!receipts.length) return `报销单 ${claimLabel} 尚无票据，无法确认发票金额。`;
    const lead = receipts.length > 1 ? `报销单 ${claimLabel} 有 ${receipts.length} 张票据，请根据序号、文件名或发票号码指定：` : `报销单 ${claimLabel} 的票据：`;
    return lead + receipts.map(receiptLine).join("；") + "。票据金额来自当前识别结果，并非申请报销总额。";
  }
  const issues = validation?.issues ?? [];
  const issueText = issues.length ? issues.map((issue) => `${issue.severity === "BLOCKING" ? "阻断" : "提醒"}：${issue.message}`).join("；") : "当前未返回校验问题";
  const receiptText = receipts.length ? receipts.map(receiptLine).join("；") : "尚无票据";
  return `报销单 ${claimLabel} 的只读摘要：报销事由：${claim.purpose || "未填写"}；申请报销总额：${money(claim.requestedAmountCent)}；${receiptTotal}；票据 ${receipts.length} 张（${receiptText}）；系统规则版本：${validation?.policyVersion || "未取得"}；提交条件：${issueText}。校验仅涵盖系统可自动判断的字段，未编码制度条款需人工核对。此摘要未申请提交确认，也未提交报销单。`;
}

function receiptTotalDescription({ claim, receipts }: Workbench): string {
  const confirmedCount = receipts.filter((receipt) => receipt.status === "EXTRACTED" && receipt.totalAmountCent !== null).length;
  const pendingCount = Math.max(claim.receiptCount ?? receipts.length, receipts.length) - confirmedCount;
  if (pendingCount > 0 && confirmedCount > 0) return `已识别票据小计：${money(claim.totalAmountCent, "待确认")}，另有 ${pendingCount} 张票据金额待确认`;
  if (pendingCount > 0) return `票据价税合计：待确认（${pendingCount} 张票据金额待确认）`;
  if (receipts.length === 0) return "票据价税合计：待确认（尚无票据）";
  return `票据价税合计：${money(claim.totalAmountCent, "待确认")}`;
}

function receiptLine(receipt: ReceiptSnapshot, index: number): string {
  const identity = [receipt.filename, receipt.invoiceNumber ? `发票号码 ${receipt.invoiceNumber}` : null].filter(Boolean).join("，");
  const label = `第 ${index + 1} 张：${identity}`;
  if (receipt.status === "REVIEW_REQUIRED" && receipt.totalAmountCent !== null) {
    return `${label}，OCR 候选金额：${money(receipt.totalAmountCent)}（待人工复核，尚未确认）`;
  }
  if (receipt.status !== "EXTRACTED" || receipt.totalAmountCent === null) {
    return `${label}，价税合计：待确认（${statusLabel(receipt.status)}）`;
  }
  return `${label}，价税合计：${money(receipt.totalAmountCent)}（${statusLabel(receipt.status)}）`;
}

function money(cents: number | null | undefined, missing = "未填写"): string {
  return typeof cents === "number" && Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : missing;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { UPLOAD_PENDING: "等待上传完成", READY_FOR_OCR: "识别中", EXTRACTED: "识别完成", REVIEW_REQUIRED: "人工复核中", QUARANTINED: "票据不可用" };
  return labels[status] ?? "状态待确认";
}
