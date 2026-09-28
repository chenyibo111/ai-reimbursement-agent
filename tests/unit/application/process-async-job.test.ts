import { expect, it } from "vitest";

import { processAsyncJob } from "@/src/application/process-async-job";

it("uses the task's receipt target and routes duplicate extraction to manual review", async () => {
  let extracted: { actorId: string; claimId: string; receiptId: string; system: true } | undefined;
  let reviewCases = 0;

  const result = await processAsyncJob(
    { id: "job-1", kind: "RECEIPT_EXTRACTION" },
    {
      jobs: {
        getById: async () => ({ id: "job-1", kind: "RECEIPT_EXTRACTION" as const, claimId: "claim-1", receiptId: "receipt-1", policySourceId: null, employeeId: "employee-1" }),
        needsOcrReview: async () => false,
        createOcrReviewCase: async () => { reviewCases += 1; },
      },
      extractReceipt: async (input) => {
        extracted = input;
        return { receiptId: "receipt-1", expenseItemCreated: false, validationIssues: [{ code: "DUPLICATE_FILE", severity: "BLOCKING" as const }] };
      },
      syncPolicySource: async () => { throw new Error("must not sync"); },
    },
  );

  expect(extracted).toEqual({ actorId: "async-job-worker", claimId: "claim-1", receiptId: "receipt-1", system: true });
  expect(result).toEqual({ type: "REVIEW_REQUIRED", failureCode: "OCR_DUPLICATE_REVIEW" });
  expect(reviewCases).toBe(1);
});

it("closes a receipt job whose target no longer exists", async () => {
  await expect(processAsyncJob(
    { id: "job-missing", kind: "RECEIPT_EXTRACTION" },
    { jobs: { getById: async () => null, needsOcrReview: async () => false, createOcrReviewCase: async () => undefined }, extractReceipt: async () => { throw new Error("must not extract"); }, syncPolicySource: async () => { throw new Error("must not sync"); } },
  )).resolves.toEqual({ type: "CLOSED" });
});

it("creates one OCR review case for low-confidence extraction", async () => {
  let reviewCases = 0;
  await expect(processAsyncJob(
    { id: "job-low", kind: "RECEIPT_EXTRACTION" },
    {
      jobs: {
        getById: async () => ({ id: "job-low", kind: "RECEIPT_EXTRACTION" as const, claimId: "claim-low", receiptId: "receipt-low", policySourceId: null, employeeId: "employee-1" }),
        needsOcrReview: async () => true,
        createOcrReviewCase: async () => { reviewCases += 1; },
      },
      extractReceipt: async () => ({ receiptId: "receipt-low", expenseItemCreated: true, validationIssues: [] }),
      syncPolicySource: async () => { throw new Error("must not sync"); },
    },
  )).resolves.toEqual({ type: "REVIEW_REQUIRED", failureCode: "OCR_LOW_CONFIDENCE" });
  expect(reviewCases).toBe(1);
});

it("dispatches a policy sync job through the existing policy sync use case", async () => {
  let synchronizedSourceId: string | undefined;
  await expect(processAsyncJob(
    { id: "job-policy", kind: "POLICY_SOURCE_SYNC" },
    {
      jobs: {
        getById: async () => ({ id: "job-policy", kind: "POLICY_SOURCE_SYNC" as const, claimId: null, receiptId: null, policySourceId: "source-1", employeeId: null }),
        needsOcrReview: async () => false,
        createOcrReviewCase: async () => undefined,
      },
      extractReceipt: async () => { throw new Error("must not extract"); },
      syncPolicySource: async ({ sourceId }) => { synchronizedSourceId = sourceId; },
    },
  )).resolves.toEqual({ type: "SUCCEEDED" });
  expect(synchronizedSourceId).toBe("source-1");
});
