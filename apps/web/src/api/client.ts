import type { Claim, ClaimPatch, ClaimSearchPage, ClaimSearchQuery, ExpenseItemPatch, Receipt, ReceiptPreview, ResolveReviewCaseInput, ReviewCase, SubmissionRequest, SubmissionSnapshot, ValidationResult } from "./generated/reimbursement";

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
export type PublishedPolicyRule = { code: string; name: string; type: "CLAIM_TOTAL_MAX" | "CATEGORY_ALLOWED" | "CATEGORY_REQUIRED_FIELD"; severity: "BLOCKING" | "WARNING"; config: { maxAmountCents: number } | { categoryCodes: string[] } | { categoryCode: string; field: "participants" | "projectCode" } };
export type PolicySourceJob = { jobId: string; status: string; failureCode: string | null; resultKind: "SYNCED" | "UNCHANGED" | null };
export type PolicySource = { id: string; type: "FEISHU_DOCX" | "FEISHU_WIKI"; title: string; canonicalUrl: string; enabled: boolean; lastSuccessfulSyncAt: string | null; lastFailureCode: string | null; sectionCount: number | null; chunkCount: number | null; lastJob: PolicySourceJob | null; createdAt: string; updatedAt: string };
export type ExpenseCategoryOption = { code: string; label: string; aliases: string[]; enabled: boolean; sortOrder: number };
export type ExpenseCatalog = { categories: ExpenseCategoryOption[]; mappings: { receiptType: string; categoryCode: string; purposeTemplate: string }[] };
export type ConfigSnapshot<T> = { domain: string; version: number; payload: T; publishedAt: string };
export type ConfigDraft<T> = { domain: string; revision: number; payload: T; authorId: string; note: string; approvedBy: string; publishedRevision?: number };
export type ConfigHistory = { action: string; actorId: string; version: number; previousVersion: number; draftRevision: number; note: string; at: string };
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
    searchClaims: (query: ClaimSearchQuery) => {
      const params = new URLSearchParams({ search: "true" });
      for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
      return request<ClaimSearchPage>(`/api/v1/claims?${params}`);
    },
    getClaim: (claimId: string) => request<Claim>(`/api/v1/claims/${encodeURIComponent(claimId)}`),
		updateExpenseItem: (claimId: string, itemId: string, patch: ExpenseItemPatch) => request<Claim>(`/api/v1/claims/${encodeURIComponent(claimId)}/items/${encodeURIComponent(itemId)}`, { method: "PATCH", body: patch, idempotent: true }),
		updateClaim: (claimId: string, patch: ClaimPatch) => request<Claim>(`/api/v1/claims/${encodeURIComponent(claimId)}`, { method: "PATCH", body: patch, idempotent: true }),
    listReceipts: (claimId: string) => request<{ items: Receipt[] }>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts`),
    deleteReceipt: (claimId: string, receiptId: string) => request<void>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts/${encodeURIComponent(receiptId)}`, { method: "DELETE", idempotent: true }),
    createClaim: (purpose: string) => request<Claim>("/api/v1/claims", { method: "POST", body: { purpose }, idempotent: true }),
    createUploadSession: (claimId: string, input: { filename: string; contentType: string; sizeBytes: number }) => request<{ receiptId: string; uploadUrl: string }>(`/api/v1/claims/${encodeURIComponent(claimId)}/uploads`, { method: "POST", body: input, idempotent: true }),
    finalizeReceipt: (claimId: string, receiptId: string) => request<{ receiptId: string; status: string }>(`/api/v1/claims/${encodeURIComponent(claimId)}/receipts`, { method: "POST", body: { receiptId }, idempotent: true }),
    getValidation: (claimId: string) => request<ValidationResult>(`/api/v1/claims/${encodeURIComponent(claimId)}/validation`),
    requestSubmission: (claimId: string, version: number) => request<SubmissionRequest>(`/api/v1/claims/${encodeURIComponent(claimId)}/submission-requests`, { method: "POST", body: { version }, idempotent: true }),
    submit: (claimId: string, confirmationToken: string) => request<SubmissionSnapshot>(`/api/v1/claims/${encodeURIComponent(claimId)}/submit`, { method: "POST", body: { confirmationToken }, idempotent: true }),
    publishPolicy: (id: string, effectiveDate: string, rules: PublishedPolicyRule[]) => request<{ id: string; status: string }>("/api/v1/admin/policies/publish", { method: "POST", body: { id, effectiveDate, rules }, idempotent: true }),
    getExpenseCatalog: () => request<ConfigSnapshot<{ categories: ExpenseCategoryOption[] }>>("/api/v1/config/expense_catalog"),
    getAdminConfig: () => request<{ active?: ConfigSnapshot<ExpenseCatalog>; draft?: ConfigDraft<ExpenseCatalog> }>("/api/v1/admin/config/expense_catalog"),
    saveConfigDraft: (domain: string, input: { expectedRevision: number; payload: ExpenseCatalog; note: string }) => request<ConfigDraft<ExpenseCatalog>>(`/api/v1/admin/config/${encodeURIComponent(domain)}/draft`, { method: "POST", body: input }),
    previewConfigDraft: (domain: string, revision: number) => request<{ draft: ConfigDraft<ExpenseCatalog>; active?: ConfigSnapshot<ExpenseCatalog> }>(`/api/v1/admin/config/${encodeURIComponent(domain)}/preview`, { method: "POST", body: { revision } }),
    publishConfigDraft: (domain: string, revision: number) => request<ConfigSnapshot<ExpenseCatalog>>(`/api/v1/admin/config/${encodeURIComponent(domain)}/publish`, { method: "POST", body: { revision } }),
    activateConfigVersion: (domain: string, input: { expectedActiveVersion: number; version: number; note: string }) => request<ConfigSnapshot<ExpenseCatalog>>(`/api/v1/admin/config/${encodeURIComponent(domain)}/activate`, { method: "POST", body: input }),
    listConfigHistory: (domain: string) => request<{ items: ConfigHistory[] }>(`/api/v1/admin/config/${encodeURIComponent(domain)}/history`),
    listPolicySources: () => request<{ sources: PolicySource[] }>("/api/v1/admin/policy-sources"),
    createPolicySource: (input: { title: string; url: string }) => request<PolicySource>("/api/v1/admin/policy-sources", { method: "POST", body: input, idempotent: true }),
    setPolicySourceEnabled: (sourceId: string, enabled: boolean) => request<PolicySource>(`/api/v1/admin/policy-sources/${encodeURIComponent(sourceId)}`, { method: "PATCH", body: { enabled }, idempotent: true }),
    syncPolicySource: (sourceId: string) => request<{ sourceId: string; jobId: string; jobStatus: string }>(`/api/v1/admin/policy-sources/${encodeURIComponent(sourceId)}/sync`, { method: "POST", idempotent: true }),
    getPolicySourceJob: (sourceId: string, jobId: string) => request<PolicySourceJob>(`/api/v1/admin/policy-sources/${encodeURIComponent(sourceId)}/jobs/${encodeURIComponent(jobId)}`),
    listReviews: () => request<{ items: ReviewCase[] }>("/api/v1/admin/reviews"),
    getReview: (reviewId: string) => request<ReviewCase>(`/api/v1/admin/reviews/${encodeURIComponent(reviewId)}`),
    getReviewReceiptPreview: (reviewId: string) => request<ReceiptPreview>(`/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/receipt-preview`),
    claimReview: (reviewId: string, expectedVersion: number) => request<ReviewCase>(`/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/claim`, { method: "POST", body: { expectedVersion }, idempotent: true }),
    resolveReview: (reviewId: string, input: ResolveReviewCaseInput) => request<ReviewCase>(`/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/resolve`, { method: "POST", body: input, idempotent: true }),
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
