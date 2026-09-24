import type { AgentProposalField, AgentTargetRef } from "@/src/domain/agent-proposal";
import type { ValidationIssue } from "@/src/domain/claim-validation";

type StoredExpenseItem = { id: string; receiptId: string | null; amountCents: number; amountSource?: string; invoiceNumber: string | null; invoiceSource?: string | null; issuedOn: string | null | Date; issuedOnSource?: string | null };
type StoredReceipt = { id: string; extractionPayload: unknown; objectKey?: string };

export type AgentContext = {
  summary: { purpose: string | null; totalAmountCents: number; expenses: Array<{ target: AgentTargetRef; amountCents: number; invoiceNumber: string | null; issuedOn: string | null }> };
  issues: ValidationIssue[];
  allowedTargets: Array<{ target: AgentTargetRef; fields: AgentProposalField[] }>;
  targetMap: Record<string, { expenseItemId?: string }>;
  claimVersion: number;
};

export function buildAgentContext(input: { claim: { id?: string; version: number; purpose: string | null; totalAmountCents: number; expenseItems: StoredExpenseItem[]; receipts: StoredReceipt[] }; issues: ValidationIssue[] }): AgentContext {
  const receipts = new Map(input.claim.receipts.map((receipt) => [receipt.id, receipt]));
  const targetMap: Record<string, { expenseItemId?: string }> = {};
  const expenses = input.claim.expenseItems.map((item, index) => {
    const target = `expense-${index + 1}` as AgentTargetRef;
    targetMap[target] = { expenseItemId: item.id };
    return { target, amountCents: item.amountCents, amountSource: item.amountSource, invoiceNumber: item.invoiceNumber, invoiceSource: item.invoiceSource, issuedOn: item.issuedOn ? toDateString(item.issuedOn) : null, issuedOnSource: item.issuedOnSource, receipt: item.receiptId ? receipts.get(item.receiptId) : undefined };
  });
  const allowed = new Map<AgentTargetRef, AgentProposalField[]>();
  if (hasIssue(input.issues, "PURPOSE_REQUIRED")) allowed.set("claim", ["purpose"]);
  for (const expense of expenses) {
    const fields: AgentProposalField[] = [];
    if (hasIssue(input.issues, "CONFIRM_INVOICE_NUMBER") && expense.invoiceSource !== "USER_ENTERED" && isLowConfidence(expense.receipt?.extractionPayload, "invoiceNumber")) fields.push("invoiceNumber");
    if (hasIssue(input.issues, "CONFIRM_ISSUED_ON") && expense.issuedOnSource !== "USER_ENTERED" && isLowConfidence(expense.receipt?.extractionPayload, "issuedOn")) fields.push("issuedOn");
    if (hasIssue(input.issues, "CONFIRM_TOTAL_AMOUNT") && expense.amountSource !== "USER_ENTERED" && isLowConfidence(expense.receipt?.extractionPayload, "totalAmountCents")) fields.push("totalAmountCents");
    if (fields.length) allowed.set(expense.target, fields);
  }
  return { summary: { purpose: input.claim.purpose, totalAmountCents: input.claim.totalAmountCents, expenses: expenses.map(({ receipt: _receipt, amountSource: _amountSource, invoiceSource: _invoiceSource, issuedOnSource: _issuedOnSource, ...expense }) => expense) }, issues: input.issues, allowedTargets: [...allowed.entries()].map(([target, fields]) => ({ target, fields })), targetMap, claimVersion: input.claim.version };
}

function hasIssue(issues: ValidationIssue[], code: string) { return issues.some((issue) => issue.severity === "BLOCKING" && issue.code === code); }
function isLowConfidence(payload: unknown, field: "invoiceNumber" | "issuedOn" | "totalAmountCents") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = (payload as Record<string, unknown>)[field];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as { confidence?: unknown; source?: unknown };
  return value.source === "EXTRACTED" && typeof value.confidence === "number" && value.confidence < 0.9;
}
function toDateString(value: string | Date) { return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10); }
