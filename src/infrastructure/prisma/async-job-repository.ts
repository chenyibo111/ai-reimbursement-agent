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
      await this.markReviewRequired(jobId, job.kind === "POLICY_SOURCE_SYNC" ? "POLICY_SYNC_RETRY_EXHAUSTED" : "OCR_RETRY_EXHAUSTED");
      if (job.kind === "POLICY_SOURCE_SYNC" && job.policySourceId) {
        await this.createPolicyReviewCase({ jobId: job.id, policySourceId: job.policySourceId, reasonCode: failureCode });
      }
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

  async getById(jobId: string): Promise<{ id: string; kind: AsyncJobKind; claimId: string | null; receiptId: string | null; policySourceId: string | null; employeeId: string | null } | null> {
    const job = await this.prisma.asyncJob.findUnique({
      where: { id: jobId },
      include: { claim: { select: { employeeId: true } } },
    });
    if (!job) return null;
    return { ...job, employeeId: job.claim?.employeeId ?? null };
  }

  async needsOcrReview(receiptId: string): Promise<boolean> {
    const receipt = await this.prisma.receipt.findUnique({ where: { id: receiptId }, select: { extractionPayload: true } });
    if (!receipt?.extractionPayload || typeof receipt.extractionPayload !== "object" || Array.isArray(receipt.extractionPayload)) return false;
    return ["invoiceNumber", "issuedOn", "totalAmountCents"].some((field) => {
      const value = (receipt.extractionPayload as Record<string, unknown>)[field];
      return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { confidence?: unknown }).confidence === "number" && (value as { confidence: number }).confidence < 0.9;
    });
  }

  async createOcrReviewCase(input: { jobId: string; claimId: string; receiptId: string; reasonCode: string }): Promise<void> {
    try {
      await this.prisma.reviewCase.create({ data: { kind: "RECEIPT_OCR", jobId: input.jobId, claimId: input.claimId, receiptId: input.receiptId, reasonCode: input.reasonCode } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }

  private async createPolicyReviewCase(input: { jobId: string; policySourceId: string; reasonCode: string }): Promise<void> {
    try {
      await this.prisma.reviewCase.create({ data: { kind: "POLICY_SYNC", jobId: input.jobId, policySourceId: input.policySourceId, reasonCode: input.reasonCode } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }

  private findActive(input: EnqueueAsyncJobInput): Promise<AsyncJob | null> {
    const where = input.kind === "RECEIPT_EXTRACTION"
      ? { kind: input.kind satisfies AsyncJobKind, receiptId: input.receiptId, status: { in: [...activeStatuses] } }
      : { kind: input.kind satisfies AsyncJobKind, policySourceId: input.policySourceId, status: { in: [...activeStatuses] } };
    return this.prisma.asyncJob.findFirst({ where, orderBy: { createdAt: "asc" } });
  }
}
