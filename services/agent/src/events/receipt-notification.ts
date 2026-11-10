import { publicWorkspaceUrl } from "./public-workspace-url";

type Receipt = { id: string; filename: string; status: string; invoiceNumber: string; ocrConfidence: number };

/** Formats only employee-safe workbench fields fetched through ReimbursementPort. */
export function formatReceiptExtractionEventNotification(input: {
  publicAppUrl: string;
  claimId: string;
  receiptId?: string;
  workbench: { receipts: Receipt[]; claim?: { itemizationMode?: string; expenseItems?: Array<{ receiptId: string; receiptType: string; expenseCategory: string; categorySource: string; amountCent: number | null; classificationStatus?: string }>; expenseItemTotalAmountCent?: number | null } };
}): string {
  const workspace = publicWorkspaceUrl(input.publicAppUrl, input.claimId);
  const workspaceLine = workspace ? `\n\n报销工作台：${workspace}` : "";
  const receipt = input.receiptId ? input.workbench.receipts.find((item) => item.id === input.receiptId) : input.workbench.receipts.at(-1);
  if (!receipt || receipt.status === "FAILED") {
    return `票据识别未完成，请在工作台补充信息或重新上传票据。${workspaceLine}`;
  }
  if (receipt.status === "REVIEW_REQUIRED") {
    return `票据识别结果需要人工复核，请以确认后的结果为准。${workspaceLine}`;
  }
  const lines = ["票据识别完成。"];
  lines.push(receipt.invoiceNumber.trim() ? `发票号码：${receipt.invoiceNumber.trim()}` : "发票号码：请在工作台补充或确认");
  if (Number.isFinite(receipt.ocrConfidence) && receipt.ocrConfidence > 0) {
    lines.push(`识别置信度：${Math.round(receipt.ocrConfidence * 100)}%`);
  }
  if (input.workbench.claim?.itemizationMode === "ITEMIZED") {
    const items = input.workbench.claim.expenseItems ?? [];
    const labels: Record<string, string> = { TAXI: "打车", DINING: "餐饮", LODGING: "住宿", TRANSPORT: "交通" };
    for (const item of items) {
      const name = input.workbench.receipts.find((candidate) => candidate.id === item.receiptId)?.filename ?? "票据";
      const category = item.expenseCategory ? `${item.categorySource === "MANUAL" ? "人工填写" : "AI 建议"}类别 ${item.expenseCategory}` : "费用类别待补充";
      lines.push(`${name}：${labels[item.receiptType] ?? "类型待确认"}，${category}，金额 ${item.amountCent === null ? "待补充" : `¥${(item.amountCent / 100).toFixed(2)}`}`);
    }
    if (items.length > 0) lines.push(`明细合计：${input.workbench.claim.expenseItemTotalAmountCent === null || input.workbench.claim.expenseItemTotalAmountCent === undefined ? "待补充" : `¥${(input.workbench.claim.expenseItemTotalAmountCent / 100).toFixed(2)}`}`);
    lines.push("请逐条核对 AI 建议；这不代表费用类别或报销政策已获确认。");
  }
  if (workspace) lines.push(`报销工作台：${workspace}`);
  return lines.join("\n");
}
