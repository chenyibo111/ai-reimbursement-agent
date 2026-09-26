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

  async findInboundByEventId(eventId: string): Promise<Omit<ClaimedInboundEvent, "id" | "status" | "claimId"> | null> {
    return this.prisma.inboundChannelEvent.findUnique({
      where: { eventId },
      select: { eventId: true, messageId: true, messageType: true, chatId: true, senderOpenId: true, chatType: true, mentionedOpenIds: true },
    });
  }

  async claimNextPending(): Promise<ClaimedInboundEvent | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.inboundChannelEvent.findFirst({
        where: { status: { in: ["PENDING", "RETRYABLE"] } },
        orderBy: { receivedAt: "asc" },
        select: { id: true },
      });
      if (!candidate) return null;

      const claimed = await tx.inboundChannelEvent.updateMany({
        where: { id: candidate.id, status: { in: ["PENDING", "RETRYABLE"] } },
        data: { status: "PROCESSING", failureCode: null },
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
        },
      });
      return event;
    });
  }

  async recoverProcessingEvents(): Promise<number> {
    const recovered = await this.prisma.inboundChannelEvent.updateMany({
      where: { status: "PROCESSING" },
      data: { status: "RETRYABLE", failureCode: "WORKER_RESTART" },
    });
    return recovered.count;
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

  async findEmployeeByOpenId(openId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { feishuUserId: openId }, select: { id: true } });
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
