import type { AsyncJob, AsyncJobKind } from "@/generated/prisma/client";
import type { Logger } from "@/src/observability/logger";

export type AsyncJobProcessResult =
  | { type: "SUCCEEDED" }
  | { type: "RETRY_WAIT"; failureCode: string }
  | { type: "REVIEW_REQUIRED"; failureCode: string }
  | { type: "CLOSED" };

export type AsyncJobWorkerDependencies = {
  jobs: {
    recoverExpiredLeases(now: Date): Promise<number>;
    claimNextJob(now: Date, leaseMs: number): Promise<Pick<AsyncJob, "id" | "kind" | "status"> & { createdAt?: Date } | null>;
    markSucceeded(jobId: string): Promise<void>;
    markRetryWait(jobId: string, failureCode: string, now: Date): Promise<void>;
    markReviewRequired(jobId: string, failureCode: string): Promise<void>;
    closeMissingTarget(jobId: string): Promise<void>;
  };
  process(job: { id: string; kind: AsyncJobKind }): Promise<AsyncJobProcessResult>;
  now(): Date;
  leaseMs: number;
  logger?: Logger;
};

export async function runAsyncJobWorkerOnce(deps: AsyncJobWorkerDependencies): Promise<boolean> {
  const now = deps.now();
  const recoveredCount = await deps.jobs.recoverExpiredLeases(now);
  if (recoveredCount > 0) deps.logger?.info("job.lease.recovered", "已回收过期任务租约", { count: recoveredCount });
  const job = await deps.jobs.claimNextJob(now, deps.leaseMs);
  if (!job) return false;

  deps.logger?.info("job.claimed", "异步任务已领取", {
    jobId: job.id,
    jobKind: job.kind,
    ...(job.createdAt ? { durationMs: Math.max(0, now.getTime() - job.createdAt.getTime()) } : {}),
  });
  const result = await deps.process({ id: job.id, kind: job.kind });
  if (result.type === "SUCCEEDED") await deps.jobs.markSucceeded(job.id);
  if (result.type === "RETRY_WAIT") await deps.jobs.markRetryWait(job.id, result.failureCode, deps.now());
  if (result.type === "REVIEW_REQUIRED") await deps.jobs.markReviewRequired(job.id, result.failureCode);
  if (result.type === "CLOSED") await deps.jobs.closeMissingTarget(job.id);
  deps.logger?.info("job.completed", "异步任务处理完成", {
    jobId: job.id,
    jobKind: job.kind,
    status: result.type,
    ...("failureCode" in result ? { failureCode: result.failureCode } : {}),
  });
  return true;
}
