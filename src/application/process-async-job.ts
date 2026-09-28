import type { AsyncJobKind } from "@/generated/prisma/client";

import type { ExtractReceiptResult } from "@/src/application/extract-receipt";
import type { AsyncJobProcessResult } from "@/src/application/run-async-job-worker";

type StoredAsyncJob = { id: string; kind: AsyncJobKind; claimId: string | null; receiptId: string | null; policySourceId: string | null; employeeId: string | null };

export type ProcessAsyncJobDeps = {
  jobs: {
    getById(id: string): Promise<StoredAsyncJob | null>;
    needsOcrReview(receiptId: string): Promise<boolean>;
    createOcrReviewCase(input: { jobId: string; claimId: string; receiptId: string; reasonCode: string }): Promise<void>;
  };
  extractReceipt(input: { actorId: string; claimId: string; receiptId: string; system: true }): Promise<ExtractReceiptResult>;
};

export async function processAsyncJob(job: { id: string; kind: AsyncJobKind }, deps: ProcessAsyncJobDeps): Promise<AsyncJobProcessResult> {
  const stored = await deps.jobs.getById(job.id);
  if (!stored || stored.kind !== job.kind) return { type: "CLOSED" };
  if (stored.kind !== "RECEIPT_EXTRACTION" || !stored.claimId || !stored.receiptId) return { type: "CLOSED" };

  try {
    const result = await deps.extractReceipt({ actorId: "async-job-worker", claimId: stored.claimId, receiptId: stored.receiptId, system: true });
    const failureCode = result.validationIssues.length > 0
      ? "OCR_DUPLICATE_REVIEW"
      : (await deps.jobs.needsOcrReview(stored.receiptId)) ? "OCR_LOW_CONFIDENCE" : null;
    if (!failureCode) return { type: "SUCCEEDED" };
    await deps.jobs.createOcrReviewCase({ jobId: stored.id, claimId: stored.claimId, receiptId: stored.receiptId, reasonCode: failureCode });
    return { type: "REVIEW_REQUIRED", failureCode };
  } catch {
    return { type: "RETRY_WAIT", failureCode: "OCR_PROVIDER_UNAVAILABLE" };
  }
}
