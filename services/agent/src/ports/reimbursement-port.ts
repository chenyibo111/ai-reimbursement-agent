/** The only boundary through which the Agent may access reimbursement data. */
export type ToolCallContext = {
  actorEmployeeId: string;
  actorRole: "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN";
  channel: "FEISHU" | "WEB";
  conversationId: string;
  toolCallId: string;
  idempotencyKey: string;
};

export type ClaimSnapshot = {
  id: string;
  claimNumber: string;
  version: number;
  status: string;
  purpose: string | null;
  expenseCategory?: string;
  participants?: string[];
  projectCode?: string;
  totalAmountCent: number | null;
  currency: "CNY";
  requestedAmountCent?: number | null;
  receiptCount?: number;
};
export type ClaimFieldPatch = { purpose?: string; expenseCategory?: string; participants?: string[]; projectCode?: string };
export type OwnedClaimSearchQuery = {
  status?: "DRAFT" | "SUBMITTED";
  createdFrom?: string;
  createdBefore?: string;
  purposeContains?: string;
  expenseCategory?: string;
  minRequestedAmountCent?: number;
  maxRequestedAmountCent?: number;
  sort?: "created_desc" | "created_asc" | "amount_desc" | "amount_asc";
  limit: number;
  cursor?: string;
  countOnly?: boolean;
};
export type OwnedClaimSearchPage = { items: ClaimSnapshot[]; totalCount: number; nextCursor: string | null };
export type ReceiptSnapshot = { id: string; claimId: string; filename: string; status: string; invoiceNumber: string; ocrConfidence: number; totalAmountCent: number | null };
export type ValidationSnapshot = { claimId: string; claimVersion: number; policyVersion: string; issues: Array<{ code: string; severity: "BLOCKING" | "WARNING"; message: string }> };

export interface ReimbursementPort {
  createClaimDraft(input: ToolCallContext & { purpose: string }): Promise<ClaimSnapshot>;
  createUploadSession(input: ToolCallContext & { claimId: string; filename: string; contentType: string; sizeBytes: number }): Promise<{ receiptId: string; uploadUrl: string }>;
  finalizeReceiptUpload(input: ToolCallContext & { claimId: string; receiptId: string }): Promise<{ receiptId: string; status: string }>;
  deleteOwnedReceipt(input: ToolCallContext & { claimId: string; receiptId: string; expectedClaimVersion: number }): Promise<void>;
  getClaimWorkbench(input: ToolCallContext & { claimId: string }): Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>;
  listOwnedClaims(input: ToolCallContext & { limit: number }): Promise<ClaimSnapshot[]>;
  searchOwnedClaims(input: ToolCallContext & { query: OwnedClaimSearchQuery }): Promise<OwnedClaimSearchPage>;
  findOwnedClaimByNumber(input: ToolCallContext & { claimNumber: string }): Promise<ClaimSnapshot | null>;
  updateClaimFields(input: ToolCallContext & { claimId: string; version: number; fields: ClaimFieldPatch }): Promise<ClaimSnapshot>;
  getClaimValidation(input: ToolCallContext & { claimId: string }): Promise<ValidationSnapshot>;
  requestSubmissionConfirmation(input: ToolCallContext & { claimId: string; version: number }): Promise<{ confirmationToken: string; claimId: string; claimVersion: number }>;
  submitClaim(input: ToolCallContext & { claimId: string; confirmationToken: string }): Promise<{ claimId: string; submissionNumber: string }>;
}
