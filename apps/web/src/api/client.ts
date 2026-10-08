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

export type TokenProvider = { getAccessToken(): string | null; refreshAccessToken(): Promise<string> };
type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown; idempotent?: boolean };
type ApiClientDeps = { fetcher?: typeof fetch; randomId?: () => string };

let activeTokenProvider: TokenProvider | null = null;

export function configureReimbursementApiTokenProvider(provider: TokenProvider) {
  activeTokenProvider = provider;
}

export function createReimbursementApi(tokenProvider: TokenProvider, deps: ApiClientDeps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    const key = options.idempotent ? randomId() : undefined;
    return send<T>(path, options, key, false);
  };

  const send = async <T>(path: string, options: RequestOptions, key: string | undefined, retried: boolean): Promise<T> => {
    const response = await fetcher(path, {
      ...options,
      headers: buildHeaders(options, tokenProvider.getAccessToken(), key),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && !retried) {
      try {
        await tokenProvider.refreshAccessToken();
      } catch {
        throw toApiError(payload, response.status);
      }
      return send<T>(path, options, key, true);
    }
    if (!response.ok) throw toApiError(payload, response.status);
    return payload as T;
  };

  return {
    listClaims: () => request<{ items: Claim[] }>("/api/v1/claims"),
    getClaim: (claimId: string) => request<Claim>(`/api/v1/claims/${encodeURIComponent(claimId)}`),
    listReceipts: (claimId: string) => request<{ items: Receipt[] }>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts`),
    createClaim: (purpose: string) => request<Claim>("/api/v1/claims", { method: "POST", body: { purpose }, idempotent: true }),
    createUploadSession: (claimId: string, input: { filename: string; contentType: string; sizeBytes: number }) => request<{ receiptId: string; uploadUrl: string }>(`/api/v1/claims/${encodeURIComponent(claimId)}/uploads`, { method: "POST", body: input, idempotent: true }),
    finalizeReceipt: (claimId: string, receiptId: string) => request<{ receiptId: string; status: string }>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts`, { method: "POST", body: { receiptId }, idempotent: true }),
    getValidation: (claimId: string) => request<ValidationResult>(`/api/v1/claims/${encodeURIComponent(claimId)}/validation`),
    requestSubmission: (claimId: string, version: number) => request<SubmissionRequest>(`/api/v1/claims/${encodeURIComponent(claimId)}/submission-requests`, { method: "POST", body: { version }, idempotent: true }),
    submit: (claimId: string, confirmationToken: string) => request<SubmissionSnapshot>(`/api/v1/claims/${encodeURIComponent(claimId)}/submit`, { method: "POST", body: { confirmationToken }, idempotent: true }),
    publishPolicy: (id: string, effectiveDate: string) => request<{ id: string; status: string }>("/api/v1/admin/policies/publish", { method: "POST", body: { id, effectiveDate }, idempotent: true }),
    resolveReview: (reviewId: string, resolution: string) => request<{ id: string; status: string }>(`/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/resolve`, { method: "POST", body: { resolution }, idempotent: true }),
  };
}

export const reimbursementApi = createReimbursementApi({
  getAccessToken: () => activeTokenProvider?.getAccessToken() ?? null,
  async refreshAccessToken() {
    if (!activeTokenProvider) throw new ReimbursementApiError("UNAUTHENTICATED", "请先登录后再操作", 401);
    return activeTokenProvider.refreshAccessToken();
  },
});

function buildHeaders(options: RequestOptions, accessToken: string | null, key: string | undefined): Headers {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (key) headers.set("Idempotency-Key", key);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function toApiError(payload: Record<string, unknown>, status: number) {
  return new ReimbursementApiError(
    typeof payload.code === "string" ? payload.code : "REQUEST_FAILED",
    typeof payload.message === "string" ? payload.message : "操作未完成，请稍后重试。",
    status,
  );
}
