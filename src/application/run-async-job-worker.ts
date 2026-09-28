import type { AsyncJob, AsyncJobKind } from "@/generated/prisma/client";

export type AsyncJobProcessResult =
  | { type: "SUCCEEDED" }
  | { type: "RETRY_WAIT"; failureCode: string }
  | { type: "REVIEW_REQUIRED"; failureCode: string }
  | { type: "CLOSED" };

export type AsyncJobWorkerDependencies = {
  jobs: {
    recoverExpiredLeases(now: Date): Promise<number>;
    claimNextJob(now: Date, leaseMs: number): Promise<Pick<AsyncJob, "id" | "kind" | "status"> | null>;
    markSucceeded(jobId: string): Promise<void>;
    markRetryWait(jobId: string, failureCode: string, now: Date): Promise<void>;
    markReviewRequired(jobId: string, failureCode: string): Promise<void>;
    closeMissingTarget(jobId: string): Promise<void>;
  };
  process(job: { id: string; kind: AsyncJobKind }): Promise<AsyncJobProcessResult>;
  now(): Date;
  leaseMs: number;
};

export async function runAsyncJobWorkerOnce(deps: AsyncJobWorkerDependencies): Promise<boolean> {
  const now = deps.now();
  await deps.jobs.recoverExpiredLeases(now);
  const job = await deps.jobs.claimNextJob(now, deps.leaseMs);
  if (!job) return false;

  const result = await deps.process({ id: job.id, kind: job.kind });
  if (result.type === "SUCCEEDED") await deps.jobs.markSucceeded(job.id);
  if (result.type === "RETRY_WAIT") await deps.jobs.markRetryWait(job.id, result.failureCode, deps.now());
  if (result.type === "REVIEW_REQUIRED") await deps.jobs.markReviewRequired(job.id, result.failureCode);
  if (result.type === "CLOSED") await deps.jobs.closeMissingTarget(job.id);
  return true;
}
