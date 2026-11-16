import type { PrismaClient } from "@/generated/prisma/client";

type NotificationSnapshot = { eventId: string; version: number; enabled: boolean; text: string | null };

export class AgentEventNotificationSnapshotRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(eventId: string): Promise<NotificationSnapshot | null> {
    return this.prisma.agentEventNotificationSnapshot.findUnique({ where: { eventId } });
  }

  async getOrCreate(candidate: NotificationSnapshot): Promise<NotificationSnapshot> {
    return this.prisma.agentEventNotificationSnapshot.upsert({ where: { eventId: candidate.eventId }, create: candidate, update: {} });
  }
}
