import { describe, expect, it } from "vitest";

import {
  canManagePolicyReview,
  canReviewOcr,
  isRetryableJobFailure,
  nextRetryAt,
} from "@/src/domain/async-job";

describe("async job domain", () => {
  it.each([
    [1, "2026-09-28T00:01:00.000Z"],
    [2, "2026-09-28T00:05:00.000Z"],
    [3, "2026-09-28T00:30:00.000Z"],
  ])("schedules retry attempt %i at the configured durable backoff", (attemptCount, expected) => {
    expect(nextRetryAt(attemptCount, new Date("2026-09-28T00:00:00.000Z")).toISOString()).toBe(expected);
  });

  it("allows only known transient provider failures to retry", () => {
    expect(isRetryableJobFailure("OCR_PROVIDER_UNAVAILABLE")).toBe(true);
    expect(isRetryableJobFailure("EMBEDDING_NETWORK_ERROR")).toBe(true);
    expect(isRetryableJobFailure("INVALID_RECEIPT")).toBe(false);
  });

  it("keeps OCR review and policy review permissions distinct", () => {
    expect(canReviewOcr("EMPLOYEE")).toBe(false);
    expect(canReviewOcr("FINANCE_REVIEWER")).toBe(true);
    expect(canReviewOcr("ADMIN")).toBe(true);
    expect(canManagePolicyReview("EMPLOYEE")).toBe(false);
    expect(canManagePolicyReview("FINANCE_REVIEWER")).toBe(false);
    expect(canManagePolicyReview("ADMIN")).toBe(true);
  });
});
