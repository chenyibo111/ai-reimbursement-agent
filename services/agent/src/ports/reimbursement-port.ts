/** The only boundary through which the Agent may access reimbursement data. */
export type ToolCallContext = {
  actorEmployeeId: string;
  channel: "FEISHU" | "WEB";
  conversationId: string;
  toolCallId: string;
  idempotencyKey: string;
};

export type ClaimSnapshot = { id: string; version: number; status: string; purpose: string | null };
export type ReceiptSnapshot = { id: string; claimId: string; filename: string; status: string; invoiceNumber: string; ocrConfidence: number };
export type ValidationSnapshot = { claimId: string; claimVersion: number; policyVersion: string; issues: Array<{ code: string; severity: "BLOCKING" | "WARNING"; message: string }> };

export interface ReimbursementPort {
  createClaimDraft(input: ToolCallContext & { purpose: string }): Promise<ClaimSnapshot>;
  createUploadSession(input: ToolCallContext & { claimId: string; filename: string; contentType: string; sizeBytes: number }): Promise<{ receiptId: string; uploadUrl: string }>;
  finalizeReceiptUpload(input: ToolCallContext & { claimId: string; receiptId: string }): Promise<{ receiptId: string; status: string }>;
  getClaimWorkbench(input: ToolCallContext & { claimId: string }): Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>;
  updateClaimFields(input: ToolCallContext & { claimId: string; version: number; purpose?: string }): Promise<ClaimSnapshot>;
  getClaimValidation(input: ToolCallContext & { claimId: string }): Promise<ValidationSnapshot>;
  requestSubmissionConfirmation(input: ToolCallContext & { claimId: string; version: number }): Promise<{ confirmationToken: string; claimId: string; claimVersion: number }>;
  submitClaim(input: ToolCallContext & { claimId: string; confirmationToken: string }): Promise<{ claimId: string; submissionNumber: string }>;
}
