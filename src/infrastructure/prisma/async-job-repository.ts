import { Prisma, type AsyncJob, type AsyncJobKind, type PrismaClient } from "@/generated/prisma/client";

import { nextRetryAt } from "@/src/domain/async-job";

const activeStatuses = ["PENDING", "RUNNING", "RETRY_WAIT"] as const;
const claimableStatuses = ["PENDING", "RETRY_WAIT"] as const;

export type EnqueueAsyncJobInput =
  | { kind: "RECEIPT_EXTRACTION"; claimId: string; receiptId: string }
  | { kind: "POLICY_SOURCE_SYNC"; policySourceId: string };

export class PrismaAsyncJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueueJob(input: EnqueueAsyncJobInput): Promise<AsyncJob> {
    const existing = await this.findActive(input);
    if (existing) return existing;

    try {
      return await this.prisma.asyncJob.create({
        data: input.kind === "RECEIPT_EXTRACTION"
          ? { kind: input.kind, claimId: input.claimId, receiptId: input.receiptId }
          : { kind: input.kind, policySourceId: input.policySourceId },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const duplicate = await this.findActive(input);
      if (!duplicate) throw error;
      return duplicate;
    }
  }

  async claimNextJob(now: Date, leaseMs: number): Promise<AsyncJob | null> {
    const candidate = await this.prisma.asyncJob.findFirst({
      where: { status: { in: [...claimableStatuses] }, availableAt: { lte: now } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    });
    if (!candidate) return null;

    const claimed = await this.prisma.asyncJob.updateMany({
      where: { id: candidate.id, status: { in: [...claimableStatuses] }, availableAt: { lte: now } },
      data: { status: "RUNNING", leaseUntil: new Date(now.getTime() + leaseMs), attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    return this.prisma.asyncJob.findUnique({ where: { id: candidate.id } });
  }

  async recoverExpiredLeases(now: Date): Promise<number> {
    const recovered = await this.prisma.asyncJob.updateMany({
      where: { status: "RUNNING", leaseUntil: { lt: now } },
      data: { status: "RETRY_WAIT", availableAt: now, leaseUntil: null, failureCode: "WORKER_LEASE_EXPIRED" },
    });
    return recovered.count;
  }

  async markSucceeded(jobId: string): Promise<void> {
    await this.prisma.asyncJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: { status: "SUCCEEDED", leaseUntil: null, failureCode: null },
    });
  }

  async markRetryWait(jobId: string, failureCode: string, now: Date): Promise<void> {
    const job = await this.prisma.asyncJob.findFirst({ where: { id: jobId, status: "RUNNING" } });
    if (!job) return;
    if (job.attemptCount >= job.maxAttempts) {
      await this.markReviewRequired(jobId, "OCR_RETRY_EXHAUSTED");
      return;
    }
    await this.prisma.asyncJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: { status: "RETRY_WAIT", availableAt: nextRetryAt(job.attemptCount, now), leaseUntil: null, failureCode },
    });
  }

  async markReviewRequired(jobId: string, failureCode: string): Promise<void> {
    await this.prisma.asyncJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: { status: "REVIEW_REQUIRED", leaseUntil: null, failureCode },
    });
  }

  async closeMissingTarget(jobId: string): Promise<void> {
    await this.prisma.asyncJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: { status: "CLOSED", leaseUntil: null, failureCode: "TARGET_MISSING" },
    });
  }

  private findActive(input: EnqueueAsyncJobInput): Promise<AsyncJob | null> {
    const where = input.kind === "RECEIPT_EXTRACTION"
      ? { kind: input.kind satisfies AsyncJobKind, receiptId: input.receiptId, status: { in: [...activeStatuses] } }
      : { kind: input.kind satisfies AsyncJobKind, policySourceId: input.policySourceId, status: { in: [...activeStatuses] } };
    return this.prisma.asyncJob.findFirst({ where, orderBy: { createdAt: "asc" } });
  }
}
