import { recordAuditEvent, type AuditEventWriter } from "@/src/application/audit-event";
import type { ExtractionValidationIssue, ReceiptExtraction } from "@/src/domain/receipt-extraction";
import type { ReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider";
import { assertClaimOwner } from "@/src/server/authorization";

export type ExtractReceiptInput = { actorId: string; claimId: string; receiptId: string };
export type ExtractReceiptResult = {
  receiptId: string;
  expenseItemCreated: boolean;
  validationIssues: ExtractionValidationIssue[];
};

type StoredReceipt = {
  id: string;
  claimId: string;
  employeeId: string;
  objectKey: string;
  mimeType: string;
  contentHash: string;
};

export type ExtractReceiptDeps = {
  claims: { getByIdOrThrow(id: string): Promise<{ employeeId: string }> };
  receipts: {
    getByIdOrThrow(id: string, claimId: string): Promise<StoredReceipt>;
    markExtracted(input: { receiptId: string; extraction: ReceiptExtraction; payload: ReceiptExtraction }): Promise<void>;
    markFailed(input: { receiptId: string }): Promise<void>;
    hasDuplicateContentHash(input: { receiptId: string; contentHash: string }): Promise<boolean>;
    hasSubmittedInvoiceNumber(input: { employeeId: string; receiptId: string; invoiceNumber: string }): Promise<boolean>;
  };
  expenses: { create(input: { claimId: string; receiptId: string; amountCents: number; issuedOn: Date | null; invoiceNumber: string | null }): Promise<void> };
  validations: { create(input: { claimId: string; code: ExtractionValidationIssue["code"]; severity: "BLOCKING"; message: string }): Promise<void> };
  provider: ReceiptExtractionProvider;
  audit: AuditEventWriter;
};

export async function extractReceipt(input: ExtractReceiptInput, deps: ExtractReceiptDeps): Promise<ExtractReceiptResult> {
  const claim = await deps.claims.getByIdOrThrow(input.claimId);
  assertClaimOwner(input.actorId, claim);
  const receipt = await deps.receipts.getByIdOrThrow(input.receiptId, input.claimId);
  let extraction: ReceiptExtraction;
  try {
    extraction = await deps.provider.extract({ objectKey: receipt.objectKey, mimeType: receipt.mimeType });
  } catch (error) {
    await deps.receipts.markFailed({ receiptId: receipt.id });
    throw error;
  }
  await deps.receipts.markExtracted({ receiptId: receipt.id, extraction, payload: extraction });

  const issues: ExtractionValidationIssue[] = [];
  if (await deps.receipts.hasDuplicateContentHash({ receiptId: receipt.id, contentHash: receipt.contentHash })) {
    issues.push({ code: "DUPLICATE_FILE", severity: "BLOCKING" });
  }
  const invoiceNumber = stringOrNull(extraction.invoiceNumber.value);
  if (invoiceNumber && (await deps.receipts.hasSubmittedInvoiceNumber({ employeeId: receipt.employeeId, receiptId: receipt.id, invoiceNumber }))) {
    issues.push({ code: "DUPLICATE_INVOICE", severity: "BLOCKING" });
  }

  for (const issue of issues) {
    await deps.validations.create({ claimId: input.claimId, ...issue, message: issue.code === "DUPLICATE_FILE" ? "重复上传的附件" : "已提交相同发票号码" });
  }

  const amount = numberOrNull(extraction.totalAmountCents.value);
  const expenseItemCreated = issues.length === 0 && amount !== null && amount > 0;
  if (expenseItemCreated) {
    await deps.expenses.create({
      claimId: input.claimId,
      receiptId: receipt.id,
      amountCents: amount,
      issuedOn: dateOrNull(extraction.issuedOn.value),
      invoiceNumber,
    });
  }
  await recordAuditEvent({ type: "RECEIPT_EXTRACTED", actorId: input.actorId, claimId: input.claimId, payload: { receiptId: receipt.id, issues } }, deps.audit);

  return { receiptId: receipt.id, expenseItemCreated, validationIssues: issues };
}

function stringOrNull(value: string | number | null): string | null { return typeof value === "string" && value ? value : null; }
function numberOrNull(value: string | number | null): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
function dateOrNull(value: string | number | null): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}
