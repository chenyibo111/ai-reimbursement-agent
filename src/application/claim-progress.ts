import type { ClaimProgressSnapshot } from "@/services/agent/src/ports/reimbursement-port";

const chatFields: Record<string, string> = {
  PURPOSE_REQUIRED: "报销事由",
  EXPENSE_CATEGORY_REQUIRED: "费用类别",
  PARTICIPANTS_REQUIRED: "参与人员",
  PROJECT_CODE_REQUIRED: "项目编号",
};

export function formatClaimProgress(progress: ClaimProgressSnapshot): string {
  const lines = [`${progress.claimNumber}：${progress.status === "SUBMITTED" ? "已提交" : "草稿"}。`];
  if (progress.status === "SUBMITTED" && progress.submissionNumber) lines.push(`提交编号：${progress.submissionNumber}。`);
  const receipts = progress.receipts.slice(0, 10);
  for (const receipt of receipts) {
    let state: string;
    if (receipt.reviewStatus === "REUPLOAD_REQUIRED" || receipt.status === "QUARANTINED") state = "票据已关闭，请删除并重新上传";
    else if (receipt.reviewStatus === "RESOLVED") state = "复核已处理";
    else if (receipt.reviewStatus === "PENDING" || receipt.status === "REVIEW_REQUIRED") state = "等待人工复核";
    else if (receipt.status === "UPLOAD_PENDING") state = "等待上传完成";
    else if (receipt.status === "READY_FOR_OCR") state = "识别中";
    else if (receipt.status === "EXTRACTED") state = "识别完成";
    else state = "状态待核对";
    lines.push(`票据 ${receipt.filename}：${state}。`);
  }
  if (progress.receipts.length > receipts.length) lines.push(`另有 ${progress.receipts.length - receipts.length} 张票据，请在工作台查看。`);
  const blocking = progress.issues.filter((issue) => issue.severity === "BLOCKING");
  if (blocking.length) {
    lines.push(`提交前还需处理：${blocking.slice(0, 5).map((issue) => issue.message).join("；")}。`);
    const fields = [...new Set(blocking.map((issue) => chatFields[issue.code]).filter(Boolean))];
    if (fields.length) lines.push(`可在对话中补充：${fields.join("、")}。`);
    if (blocking.some((issue) => !chatFields[issue.code])) lines.push("其他缺项请到该单 Web 工作台核对和处理。");
  }
  if (progress.approval === "NOT_CONNECTED" || progress.payment === "NOT_CONNECTED") lines.push("当前系统未接入审批/付款进度。");
  return lines.join("\n").slice(0, 950);
}
