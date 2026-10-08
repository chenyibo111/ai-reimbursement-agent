export function formatCNYFromCent(value: number) {
  return `￥${(value / 100).toFixed(2)}`;
}

export function claimAmountSummary(totalAmountCent: number | null, missingAmountReceiptCount: number) {
  if (totalAmountCent === null) return "已识别金额待补充";
  const amount = `已识别金额 ${formatCNYFromCent(totalAmountCent)}`;
  return missingAmountReceiptCount > 0 ? `${amount} · 另有 ${missingAmountReceiptCount} 份待补充` : amount;
}
