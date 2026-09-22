import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export type AuditEventInput = {
  type: string;
  actorId: string;
  claimId: string;
  payload: Record<string, unknown>;
};

export type AuditEventWriter = {
  append(event: AuditEventInput): Promise<void>;
};

export async function recordAuditEvent(event: AuditEventInput, writer: AuditEventWriter): Promise<void> {
  await writer.append(event);
}

export function createPrismaAuditEventWriter(prisma: PrismaClient): AuditEventWriter {
  return {
    async append(event) {
      await prisma.auditEvent.create({
        data: {
          type: event.type,
          actorId: event.actorId,
          claimId: event.claimId,
          payload: event.payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
