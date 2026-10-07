// Generated-shape facade for api/openapi/reimbursement-v1.yaml.
// The repository deliberately keeps this small typed surface checked in until
// a CI OpenAPI generator is introduced with the Go API deployment pipeline.

export type ClaimStatus = "DRAFT" | "PROCESSING" | "NEEDS_INFORMATION" | "AWAITING_CONFIRMATION" | "SUBMITTED";
export type ReceiptStatus = "UPLOAD_PENDING" | "READY_FOR_OCR" | "EXTRACTED" | "REVIEW_REQUIRED" | "QUARANTINED";

export interface Claim {
  id: string;
  ownerId?: string;
  status: ClaimStatus;
  version: number;
  purpose: string | null;
  expenseCategory: string | null;
  participants: string[];
  projectCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Receipt {
  id: string;
  claimId: string;
  filename: string;
  status: ReceiptStatus;
  invoiceNumber: string;
  ocrConfidence: number;
  updatedAt: string;
}

export interface ValidationIssue {
  code: string;
  severity: "BLOCKING" | "WARNING";
  message: string;
}

export interface ValidationResult {
  claimId: string;
  claimVersion: number;
  policyVersion: string;
  issues: ValidationIssue[];
}

export interface SubmissionRequest {
  confirmationToken: string;
  claimId: string;
  claimVersion: number;
  policyVersion: string;
  expiresAt: string;
}

export interface SubmissionSnapshot {
  claimId: string;
  submissionId?: string;
  status?: string;
}
