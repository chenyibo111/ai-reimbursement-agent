import type { Claim, Receipt, SubmissionRequest, SubmissionSnapshot, ValidationResult } from "./generated/reimbursement";

export class ReimbursementApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown; idempotent?: boolean };

function idempotencyKey() {
  return crypto.randomUUID();
}

function buildHeaders(options: RequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotent) headers.set("Idempotency-Key", idempotencyKey());
  // Local-only bridge while the production SSO/token exchange is migrated in
  // Task 10. Vite omits this branch from a production build.
  if (import.meta.env.DEV && import.meta.env.VITE_REIMBURSEMENT_DEV_TOKEN) {
    headers.set("Authorization", `Bearer ${import.meta.env.VITE_REIMBURSEMENT_DEV_TOKEN}`);
  }
  return headers;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: buildHeaders(options),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ReimbursementApiError(
      typeof payload.code === "string" ? payload.code : "REQUEST_FAILED",
      typeof payload.message === "string" ? payload.message : "操作未完成，请稍后重试。",
      response.status,
    );
  }
  return payload as T;
}

export const reimbursementApi = {
  listClaims: () => request<{ items: Claim[] }>("/api/v1/claims"),
  getClaim: (claimId: string) => request<Claim>(`/api/v1/claims/${encodeURIComponent(claimId)}`),
  listReceipts: (claimId: string) => request<{ items: Receipt[] }>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts`),
  createClaim: (purpose: string) => request<Claim>("/api/v1/claims", { method: "POST", body: { purpose }, idempotent: true }),
  createUploadSession: (claimId: string, input: { filename: string; contentType: string; sizeBytes: number }) =>
    request<{ receiptId: string; uploadUrl: string }>(`/api/v1/claims/${encodeURIComponent(claimId)}/uploads`, { method: "POST", body: input, idempotent: true }),
  finalizeReceipt: (claimId: string, receiptId: string) =>
    request<{ receiptId: string; status: string }>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts`, { method: "POST", body: { receiptId }, idempotent: true }),
  getValidation: (claimId: string) => request<ValidationResult>(`/api/v1/claims/${encodeURIComponent(claimId)}/validation`),
  requestSubmission: (claimId: string, version: number) =>
    request<SubmissionRequest>(`/api/v1/claims/${encodeURIComponent(claimId)}/submission-requests`, { method: "POST", body: { version }, idempotent: true }),
  submit: (claimId: string, confirmationToken: string) =>
    request<SubmissionSnapshot>(`/api/v1/claims/${encodeURIComponent(claimId)}/submit`, { method: "POST", body: { confirmationToken }, idempotent: true }),
  publishPolicy: (id: string, effectiveDate: string) => request<{ id: string; status: string }>("/api/v1/admin/policies/publish", { method: "POST", body: { id, effectiveDate }, idempotent: true }),
  resolveReview: (reviewId: string, resolution: string) => request<{ id: string; status: string }>(`/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/resolve`, { method: "POST", body: { resolution }, idempotent: true }),
};
