import type { PrismaClient } from "@/generated/prisma/client";

/** Durable idempotency boundary for Agent consumers of at-least-once domain events. */
export class PrismaAgentProcessedEventRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly consumerName: string,
  ) {}

  async wasProcessed(eventId: string): Promise<boolean> {
    const record = await this.prisma.agentProcessedEvent.findUnique({
      where: { eventId_consumerName: { eventId, consumerName: this.consumerName } },
      select: { eventId: true },
    });
    return Boolean(record);
  }

  async markProcessed(eventId: string): Promise<void> {
    try {
      await this.prisma.agentProcessedEvent.create({
        data: { eventId, consumerName: this.consumerName },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
