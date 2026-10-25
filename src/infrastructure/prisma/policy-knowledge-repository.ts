import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient, type PolicySourceType } from "@/generated/prisma/client";

const dimensions = 1024;

export class PrismaPolicyKnowledgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createSource(input: { type: PolicySourceType; token: string; canonicalUrl: string; title: string; actorId: string }) {
    return this.prisma.policySource.create({ data: { type: input.type, resourceToken: input.token, canonicalUrl: input.canonicalUrl, title: input.title.trim(), createdByEmployeeId: input.actorId } });
  }

  async getEnabledSourceForSync(sourceId: string) {
    return this.prisma.policySource.findFirst({ where: { id: sourceId, enabled: true } });
  }

  async getLatestContentHash(sourceId: string) {
    const snapshot = await this.prisma.policyDocumentSnapshot.findFirst({ where: { sourceId, status: "ACTIVE" }, orderBy: { activatedAt: "desc" }, select: { contentHash: true } });
    return snapshot?.contentHash ?? null;
  }

  async getLatestIndexState(sourceId: string) {
    const snapshot = await this.prisma.policyDocumentSnapshot.findFirst({ where: { sourceId, status: "ACTIVE" }, orderBy: { activatedAt: "desc" }, select: { contentHash: true, indexVersion: true } });
    return snapshot ?? null;
  }

  async markSyncFailure(input: { sourceId: string; code: string }) {
    await this.prisma.policySource.update({ where: { id: input.sourceId }, data: { lastFailureCode: input.code } });
  }

  async stageSnapshot(input: { sourceId: string; revision: string; contentHash: string; title: string; blocks: Prisma.InputJsonValue; indexVersion?: number; sections?: Array<{ sequence: number; headingPath: string[]; content: string; sourceAnchor: string | null; complete: boolean }>; chunks: Array<{ sequence?: number; sectionSequence?: number; content: string; headingPath: string[]; sourceAnchor?: string | null; embedding: number[] }> }) {
    input.chunks.forEach((chunk) => assertVector(chunk.embedding));
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.policyDocumentSnapshot.create({ data: { sourceId: input.sourceId, sourceRevision: input.revision, contentHash: input.contentHash, title: input.title, blocks: input.blocks, indexVersion: input.indexVersion ?? 1 } });
      const sectionIds = new Map<number, string>();
      for (const section of input.sections ?? []) {
        const stored = await tx.policySection.create({ data: { snapshotId: snapshot.id, sequence: section.sequence, headingPath: section.headingPath, content: section.content, sourceAnchor: section.sourceAnchor, complete: section.complete } });
        sectionIds.set(section.sequence, stored.id);
      }
      for (const [sequence, chunk] of input.chunks.entries()) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "PolicyChunk" ("id", "snapshotId", "sectionId", "sequence", "headingPath", "content", "sourceAnchor", "embedding", "createdAt")
          VALUES (${randomUUID()}, ${snapshot.id}, ${chunk.sectionSequence === undefined ? null : sectionIds.get(chunk.sectionSequence) ?? null}, ${chunk.sequence ?? sequence}, ${chunk.headingPath}, ${chunk.content}, ${chunk.sourceAnchor ?? null}, ${toVectorLiteral(chunk.embedding)}::vector, CURRENT_TIMESTAMP)
        `);
      }
      return snapshot;
    });
  }

  async activateSnapshot(input: { sourceId: string; snapshotId: string; now: Date }) {
    await this.prisma.$transaction(async (tx) => {
      const staged = await tx.policyDocumentSnapshot.findFirst({ where: { id: input.snapshotId, sourceId: input.sourceId, status: "STAGED" } });
      if (!staged) throw new Error("staged policy snapshot not found");
      await tx.policyDocumentSnapshot.updateMany({ where: { sourceId: input.sourceId, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
      await tx.policyDocumentSnapshot.update({ where: { id: input.snapshotId }, data: { status: "ACTIVE", activatedAt: input.now } });
      await tx.policySource.update({ where: { id: input.sourceId }, data: { lastSuccessfulSyncAt: input.now, lastFailureCode: null } });
    });
  }

  async searchChunks(input: { vector: number[]; limit: number }) {
    assertVector(input.vector);
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit)));
    return this.prisma.$queryRaw<Array<{ id: string; snapshotId: string; sectionId: string | null; content: string; headingPath: string[]; sourceAnchor: string | null; canonicalUrl: string; title: string; score: number }>>(Prisma.sql`
      SELECT chunk."id", chunk."snapshotId", chunk."sectionId", chunk."content", chunk."headingPath", chunk."sourceAnchor", source."canonicalUrl", snapshot."title",
        1 - (chunk."embedding" <=> ${toVectorLiteral(input.vector)}::vector) AS "score"
      FROM "PolicyChunk" AS chunk
      JOIN "PolicyDocumentSnapshot" AS snapshot ON snapshot."id" = chunk."snapshotId"
      JOIN "PolicySource" AS source ON source."id" = snapshot."sourceId"
      WHERE snapshot."status" = 'ACTIVE' AND source."enabled" = true AND chunk."embedding" IS NOT NULL
      ORDER BY chunk."embedding" <=> ${toVectorLiteral(input.vector)}::vector ASC
      LIMIT ${limit}
    `);
  }
}

function assertVector(vector: number[]) {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) throw new Error("embedding vector must contain 1024 finite values");
}
function toVectorLiteral(vector: number[]) { return `[${vector.join(",")}]`; }
