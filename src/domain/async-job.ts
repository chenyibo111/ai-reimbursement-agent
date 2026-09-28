export type EmployeeRoleName = "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN";

const retryableFailureCodes = new Set([
  "OCR_PROVIDER_UNAVAILABLE",
  "OCR_NETWORK_ERROR",
  "OCR_TIMEOUT",
  "EMBEDDING_NETWORK_ERROR",
  "FEISHU_DOCUMENT_UNAVAILABLE",
  "INTERNAL_RETRYABLE",
]);

const retryDelaysMinutes = [1, 5, 30] as const;

export function nextRetryAt(attemptCount: number, now: Date): Date {
  const index = Math.max(0, Math.min(attemptCount - 1, retryDelaysMinutes.length - 1));
  return new Date(now.getTime() + retryDelaysMinutes[index] * 60_000);
}

export function isRetryableJobFailure(code: string): boolean {
  return retryableFailureCodes.has(code);
}

export function canReviewOcr(role: EmployeeRoleName): boolean {
  return role === "FINANCE_REVIEWER" || role === "ADMIN";
}

export function canManagePolicyReview(role: EmployeeRoleName): boolean {
  return role === "ADMIN";
}
