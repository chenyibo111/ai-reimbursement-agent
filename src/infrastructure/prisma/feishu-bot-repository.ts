import type { InboundChannelEventStatus, PrismaClient } from "@/generated/prisma/client";

export type RecordInboundEvent = {
  eventId: string;
  messageId?: string | null;
  messageType: string;
  chatId: string;
  senderOpenId: string;
  chatType?: "p2p" | "group";
  mentionedOpenIds?: string[];
};

export type ClaimedInboundEvent = {
  id: string;
  eventId: string;
  messageId: string | null;
  messageType: string;
  chatId: string;
  senderOpenId: string;
  chatType: string;
  mentionedOpenIds: string[];
  status: InboundChannelEventStatus;
  claimId: string | null;
  attemptCount: number;
  replyText: string | null;
  deliveryAttemptCount: number;
};

export class FeishuBotRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async recordInbound(input: RecordInboundEvent): Promise<{ id: string; shouldProcess: boolean }> {
    const messageId = input.messageId?.trim() || null;
    const existing = await this.prisma.inboundChannelEvent.findFirst({
      where: { OR: [{ eventId: input.eventId }, ...(messageId ? [{ messageId }] : [])] },
      select: { id: true },
    });
    if (existing) return { id: existing.id, shouldProcess: false };

    try {
      const created = await this.prisma.inboundChannelEvent.create({
        data: { ...input, messageId, chatType: input.chatType ?? "p2p", mentionedOpenIds: input.mentionedOpenIds ?? [] },
        select: { id: true },
      });
      return { id: created.id, shouldProcess: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.prisma.inboundChannelEvent.findFirst({
        where: { OR: [{ eventId: input.eventId }, ...(messageId ? [{ messageId }] : [])] },
        select: { id: true },
      });
      if (!duplicate) throw error;
      return { id: duplicate.id, shouldProcess: false };
    }
  }

  async findInboundByEventId(eventId: string): Promise<Omit<ClaimedInboundEvent, "id" | "status" | "claimId" | "replyText" | "deliveryAttemptCount"> | null> {
    return this.prisma.inboundChannelEvent.findUnique({
      where: { eventId },
      select: { eventId: true, messageId: true, messageType: true, chatId: true, senderOpenId: true, chatType: true, mentionedOpenIds: true, attemptCount: true },
    });
  }

  async claimNextPending(): Promise<ClaimedInboundEvent | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.inboundChannelEvent.findFirst({
        where: { OR: [
          { status: { in: ["PENDING", "RETRYABLE", "REPLY_PENDING"] } },
          { status: "REPLY_RETRYABLE", nextDeliveryAttemptAt: { lte: new Date() } },
        ] },
        orderBy: { receivedAt: "asc" },
        select: { id: true, status: true },
      });
      if (!candidate) return null;

      const delivery = candidate.status === "REPLY_PENDING" || candidate.status === "REPLY_RETRYABLE";

      const claimed = await tx.inboundChannelEvent.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: delivery
          ? { status: "REPLY_PROCESSING", failureCode: null, deliveryAttemptCount: { increment: 1 } }
          : { status: "PROCESSING", failureCode: null, attemptCount: { increment: 1 } },
      });
      if (claimed.count !== 1) return null;

      const event = await tx.inboundChannelEvent.findUniqueOrThrow({
        where: { id: candidate.id },
        select: {
          id: true,
          eventId: true,
          messageId: true,
          messageType: true,
          chatId: true,
          senderOpenId: true,
          chatType: true,
          mentionedOpenIds: true,
          status: true,
          claimId: true,
          attemptCount: true,
          replyText: true,
          deliveryAttemptCount: true,
        },
      });
      return event;
    });
  }

  async recoverProcessingEvents(olderThan: Date = new Date()): Promise<{ recovered: number; uncertainDeliveryFailed: number }> {
    const cutoff = new Date(Date.now() - 55 * 60_000);
    const uncertain = await this.prisma.inboundChannelEvent.updateMany({
      where: { status: { in: ["REPLY_PROCESSING", "REPLY_RETRYABLE"] }, updatedAt: { lt: cutoff } },
      data: { status: "REPLY_FAILED", failureCode: "DELIVERY_OUTCOME_UNKNOWN" },
    });
    const recovered = await this.prisma.inboundChannelEvent.updateMany({
      where: { status: "PROCESSING", updatedAt: { lt: olderThan } },
      data: { status: "RETRYABLE", failureCode: "WORKER_RESTART" },
    });
    const deliveries = await this.prisma.inboundChannelEvent.updateMany({
      where: { status: "REPLY_PROCESSING", updatedAt: { lt: olderThan } },
      data: { status: "REPLY_RETRYABLE", failureCode: "WORKER_RESTART", nextDeliveryAttemptAt: new Date() },
    });
    return { recovered: recovered.count + deliveries.count, uncertainDeliveryFailed: uncertain.count };
  }

  async markProcessed(id: string): Promise<void> {
    await this.prisma.inboundChannelEvent.update({
      where: { id },
      data: { status: "PROCESSED", processedAt: new Date(), failureCode: null },
    });
  }

  async markRetryableFailure(id: string, code: string): Promise<void> {
    await this.prisma.inboundChannelEvent.update({
      where: { id },
      data: { status: "RETRYABLE", failureCode: code.slice(0, 80) },
    });
  }

  async markReplyPending(id: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 10_000) throw new Error("invalid Feishu reply");
    await this.prisma.inboundChannelEvent.update({
      where: { id },
      data: { status: "REPLY_PENDING", replyText: text, nextDeliveryAttemptAt: null, failureCode: null },
    });
  }

  async markReplyDelivered(id: string): Promise<void> {
    await this.prisma.inboundChannelEvent.update({
      where: { id },
      data: { status: "PROCESSED", deliveredAt: new Date(), processedAt: new Date(), nextDeliveryAttemptAt: null, failureCode: null },
    });
  }

  async markReplyRetryableFailure(id: string, code: string): Promise<void> {
    const event = await this.prisma.inboundChannelEvent.findUniqueOrThrow({ where: { id }, select: { deliveryAttemptCount: true } });
    const delays = [5_000, 20_000, 60_000, 180_000];
    const delay = delays[Math.min(Math.max(event.deliveryAttemptCount - 1, 0), delays.length - 1)];
    await this.prisma.inboundChannelEvent.update({
      where: { id },
      data: { status: "REPLY_RETRYABLE", failureCode: code.slice(0, 80), nextDeliveryAttemptAt: new Date(Date.now() + delay) },
    });
  }

  async markReplyFailed(id: string, code: string): Promise<void> {
    await this.prisma.inboundChannelEvent.update({
      where: { id },
      data: { status: "REPLY_FAILED", failureCode: code.slice(0, 80), nextDeliveryAttemptAt: null },
    });
  }

  async getConversation(employeeId: string, chatId: string): Promise<{ claimId: string } | null> {
    return this.prisma.feishuConversation.findUnique({
      where: { employeeId_chatId: { employeeId, chatId } },
      select: { claimId: true },
    });
  }

  async setConversation(employeeId: string, chatId: string, claimId: string): Promise<void> {
    await this.prisma.feishuConversation.upsert({
      where: { employeeId_chatId: { employeeId, chatId } },
      create: { employeeId, chatId, claimId },
      update: { claimId, lastActiveAt: new Date() },
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
