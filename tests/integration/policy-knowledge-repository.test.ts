import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.policyChunk.deleteMany();
  await prisma.policyDocumentSnapshot.deleteMany();
  await prisma.policySource.deleteMany();
});
afterAll(async () => prisma.$disconnect());

it("activates a complete snapshot while retaining the previous snapshot as history", async () => {
  const repository = new PrismaPolicyKnowledgeRepository(prisma);
  const source = await repository.createSource({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789", title: "差旅制度", actorId: "employee-finance" });
  expect(await repository.getEnabledSourceForSync(source.id)).toMatchObject({ id: source.id, enabled: true });

  const first = await repository.stageSnapshot({ sourceId: source.id, revision: "1", contentHash: "hash-1", title: "差旅制度", blocks: [], chunks: [{ content: "住宿上限 500 元", headingPath: ["住宿"], sourceAnchor: "#住宿", embedding: vector }] });
  await repository.activateSnapshot({ sourceId: source.id, snapshotId: first.id, now: new Date("2026-09-27T00:00:00Z") });
  const second = await repository.stageSnapshot({ sourceId: source.id, revision: "2", contentHash: "hash-2", title: "差旅制度", blocks: [], chunks: [{ content: "住宿上限 600 元", headingPath: ["住宿"], sourceAnchor: "#住宿", embedding: vector }] });
  await repository.activateSnapshot({ sourceId: source.id, snapshotId: second.id, now: new Date("2026-09-27T01:00:00Z") });

  await expect(prisma.policyDocumentSnapshot.findUnique({ where: { id: first.id } })).resolves.toMatchObject({ status: "ARCHIVED" });
  await expect(prisma.policyDocumentSnapshot.findUnique({ where: { id: second.id } })).resolves.toMatchObject({ status: "ACTIVE" });
  await expect(repository.searchChunks({ vector, limit: 3 })).resolves.toEqual([
    expect.objectContaining({ snapshotId: second.id, content: "住宿上限 600 元", canonicalUrl: source.canonicalUrl }),
  ]);
});

it("rejects a non-1024-dimension vector before persistence", async () => {
  const repository = new PrismaPolicyKnowledgeRepository(prisma);
  const source = await repository.createSource({ type: "FEISHU_WIKI", token: "XYZabc0123456789", canonicalUrl: "https://acme.feishu.cn/wiki/XYZabc0123456789", title: "费用制度", actorId: "employee-finance" });
  await expect(repository.stageSnapshot({ sourceId: source.id, revision: "1", contentHash: "hash", title: "费用制度", blocks: [], chunks: [{ content: "正文", headingPath: [], embedding: [1] }] })).rejects.toThrow("embedding vector must contain 1024 finite values");
});
