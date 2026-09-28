import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { nextRetryAt } from "@/src/domain/async-job";

const deliverableJobStatuses = ["SUCCEEDED", "REVIEW_REQUIRED", "CLOSED"] as const;
const claimableStatuses = ["PENDING", "RETRY_WAIT"] as const;

export type ClaimedReceiptExtractionNotification = {
  id: string;
  jobId: string;
  receiptId: string | null;
  claimId: string | null;
  conversationId: string;
  chatId: string;
  status: "PROCESSING";
  attemptCount: number;
  maxAttempts: number;
  job: {
    status: "SUCCEEDED" | "REVIEW_REQUIRED" | "CLOSED";
    failureCode: string | null;
    receipt: { extractionPayload: Prisma.JsonValue | null } | null;
  };
};

export class ReceiptExtractionNotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createForFeishuUpload(input: { jobId: string; receiptId: string; claimId: string; conversationId: string; chatId: string }) {
    try {
      return await this.prisma.receiptExtractionNotification.create({
        data: { ...input, channel: "FEISHU" },
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      return this.prisma.receiptExtractionNotification.findUniqueOrThrow({ where: { jobId: input.jobId } });
    }
  }

  async recoverExpiredLeases(now: Date): Promise<number> {
    const recovered = await this.prisma.receiptExtractionNotification.updateMany({
      where: { status: "PROCESSING", leaseUntil: { lt: now } },
      data: { status: "RETRY_WAIT", availableAt: now, leaseUntil: null, failureCode: "WORKER_LEASE_EXPIRED" },
    });
    return recovered.count;
  }

  async claimNextDeliverable(now: Date, leaseMs: number): Promise<ClaimedReceiptExtractionNotification | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.receiptExtractionNotification.findFirst({
        where: {
          status: { in: [...claimableStatuses] },
          availableAt: { lte: now },
          job: { is: { kind: "RECEIPT_EXTRACTION", status: { in: [...deliverableJobStatuses] } } },
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      if (!candidate) return null;

      const claimed = await tx.receiptExtractionNotification.updateMany({
        where: { id: candidate.id, status: { in: [...claimableStatuses] }, availableAt: { lte: now } },
        data: { status: "PROCESSING", leaseUntil: new Date(now.getTime() + leaseMs), attemptCount: { increment: 1 }, failureCode: null },
      });
      if (claimed.count !== 1) return null;

      const notification = await tx.receiptExtractionNotification.findUniqueOrThrow({
        where: { id: candidate.id },
        include: { job: { include: { receipt: { select: { extractionPayload: true } } } } },
      });
      if (!deliverableJobStatuses.includes(notification.job.status as typeof deliverableJobStatuses[number])) return null;
      return {
        id: notification.id,
        jobId: notification.jobId,
        receiptId: notification.receiptId,
        claimId: notification.claimId,
        conversationId: notification.conversationId,
        chatId: notification.chatId,
        status: "PROCESSING",
        attemptCount: notification.attemptCount,
        maxAttempts: notification.maxAttempts,
        job: {
          status: notification.job.status as ClaimedReceiptExtractionNotification["job"]["status"],
          failureCode: notification.job.failureCode,
          receipt: notification.job.receipt,
        },
      };
    });
  }

  async markSent(id: string, now: Date): Promise<void> {
    await this.prisma.receiptExtractionNotification.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "SENT", sentAt: now, leaseUntil: null, failureCode: null },
    });
  }

  async markRetryWait(id: string, failureCode: string, now: Date): Promise<void> {
    const notification = await this.prisma.receiptExtractionNotification.findFirst({ where: { id, status: "PROCESSING" } });
    if (!notification) return;
    const exhausted = notification.attemptCount >= notification.maxAttempts;
    await this.prisma.receiptExtractionNotification.updateMany({
      where: { id, status: "PROCESSING" },
      data: exhausted
        ? { status: "CLOSED", leaseUntil: null, failureCode: failureCode.slice(0, 80) }
        : { status: "RETRY_WAIT", availableAt: nextRetryAt(notification.attemptCount, now), leaseUntil: null, failureCode: failureCode.slice(0, 80) },
    });
  }

  async close(id: string, failureCode: string): Promise<void> {
    await this.prisma.receiptExtractionNotification.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "CLOSED", leaseUntil: null, failureCode: failureCode.slice(0, 80) },
    });
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
