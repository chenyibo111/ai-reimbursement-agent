export type ClaimReceipt = {
  id: string;
  status: string;
  receiptType: string | null;
  extractionPayload: Record<string, unknown> | null;
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
};

export type ValidationIssue = { code: string; severity: "BLOCKING" | "WARNING"; message: string };
export type ConfirmableExpenseField = "invoiceNumber" | "issuedOn" | "totalAmountCents";

export function formatMoney(cents: number) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);
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
