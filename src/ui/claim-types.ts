export type ClaimReceipt = {
  id: string;
  status: string;
  receiptType: string | null;
  extractionPayload: Record<string, unknown> | null;
  originalFilename?: string | null;
};

export type ExpenseItem = {
  id: string;
  receiptId: string | null;
  amountCents: number;
  issuedOn: string | null;
  invoiceNumber: string | null;
  invoiceSource?: string | null;
  issuedOnSource?: string | null;
  expenseCategory: string | null;
  amountSource: string;
};

export type ClaimSummary = {
  id: string;
  status: string;
  version: number;
  purpose: string | null;
  totalAmountCents: number;
  receipts: ClaimReceipt[];
  expenseItems: ExpenseItem[];
  agentProposals: AgentProposal[];
};

export type AgentProposal = {
  id: string;
  target: string;
  field: "purpose" | "invoiceNumber" | "issuedOn" | "totalAmountCents";
  displayValue: string;
  reason: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  claimVersion: number;
};

export type ValidationIssue = { code: string; severity: "BLOCKING" | "WARNING"; message: string };
export type ConfirmableExpenseField = "invoiceNumber" | "issuedOn" | "totalAmountCents";

export function hasBlockingValidation(issues: ValidationIssue[]) {
  return issues.some((issue) => issue.severity === "BLOCKING");
}

export function formatMoney(cents: number) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);
}

export function receiptDisplayName(receipt: Pick<ClaimReceipt, "id" | "originalFilename">) {
  return receipt.originalFilename?.trim() || `票据 #${receipt.id.slice(-6).toUpperCase()}`;
}

export function receiptStatusLabel(status: string) {
  return ({
    PENDING: "等待识别",
    EXTRACTING: "正在识别",
    EXTRACTED: "已识别",
    FAILED: "识别失败",
  } as Record<string, string>)[status] ?? "处理中";
}

export function extractedReceiptField(receipt: ClaimReceipt, fieldName: ConfirmableExpenseField) {
  const candidate = receipt.extractionPayload?.[fieldName];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const field = candidate as { value?: unknown; confidence?: unknown };
  if (typeof field.value !== "string" && typeof field.value !== "number") return null;
  return { value: field.value, confidence: typeof field.confidence === "number" ? field.confidence : null };
}

export function lowConfidenceAmount(receipt: ClaimReceipt | undefined) {
  return lowConfidenceField(receipt, "totalAmountCents");
}

export function lowConfidenceField(receipt: ClaimReceipt | undefined, fieldName: ConfirmableExpenseField) {
  const candidate = receipt?.extractionPayload?.[fieldName];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const field = candidate as { confidence?: unknown; source?: unknown };
  return field.source === "EXTRACTED" && typeof field.confidence === "number" && field.confidence < 0.9;
}
