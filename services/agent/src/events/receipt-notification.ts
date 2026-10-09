type Receipt = { id: string; filename: string; status: string; invoiceNumber: string; ocrConfidence: number };

/** Formats only employee-safe workbench fields fetched through ReimbursementPort. */
export function formatReceiptExtractionEventNotification(input: {
  publicAppUrl: string;
  claimId: string;
  workbench: { receipts: Receipt[] };
}): string {
  const workspace = `${input.publicAppUrl.replace(/\/$/, "")}/claims/${encodeURIComponent(input.claimId)}`;
  const receipt = input.workbench.receipts.at(-1);
  if (!receipt || receipt.status === "FAILED") {
    return `票据识别未完成，请在工作台补充信息或重新上传票据。\n\n报销工作台：${workspace}`;
  }
  if (receipt.status === "REVIEW_REQUIRED") {
    return `票据识别结果需要人工复核，请以确认后的结果为准。\n\n报销工作台：${workspace}`;
  }
  const lines = ["票据识别完成。"];
  lines.push(receipt.invoiceNumber.trim() ? `发票号码：${receipt.invoiceNumber.trim()}` : "发票号码：请在工作台补充或确认");
  if (Number.isFinite(receipt.ocrConfidence) && receipt.ocrConfidence > 0) {
    lines.push(`识别置信度：${Math.round(receipt.ocrConfidence * 100)}%`);
  }
  lines.push(`报销工作台：${workspace}`);
  return lines.join("\n");
}
