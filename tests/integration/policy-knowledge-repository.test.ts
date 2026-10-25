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

it("stores v2 sections alongside a v1 snapshot with the same source revision", async () => {
  const repository = new PrismaPolicyKnowledgeRepository(prisma);
  const source = await repository.createSource({ type: "FEISHU_DOCX", token: "rateTableDoc12345", canonicalUrl: "https://acme.feishu.cn/docx/rateTableDoc12345", title: "差旅制度", actorId: "employee-finance" });
  await repository.stageSnapshot({ sourceId: source.id, revision: "same", contentHash: "same-content", title: source.title, blocks: [], indexVersion: 1, chunks: [{ content: "北京上海 600 元", headingPath: [], embedding: vector }] });
  const v2 = await repository.stageSnapshot({ sourceId: source.id, revision: "same", contentHash: "same-content", title: source.title, blocks: [], indexVersion: 2,
    sections: [{ sequence: 0, headingPath: ["住宿费"], content: "北京上海 600 元\n其他城市 400 元", sourceAnchor: "#lodging", complete: true }],
    chunks: [{ sequence: 0, sectionSequence: 0, content: "北京上海 600 元", headingPath: ["住宿费"], sourceAnchor: "#lodging", embedding: vector }],
  });
  await repository.activateSnapshot({ sourceId: source.id, snapshotId: v2.id, now: new Date("2026-10-25T00:00:00Z") });
  expect(await repository.getLatestIndexState(source.id)).toEqual({ contentHash: "same-content", indexVersion: 2 });
  expect(await prisma.policySection.findMany({ where: { snapshotId: v2.id } })).toEqual([expect.objectContaining({ headingPath: ["住宿费"], content: "北京上海 600 元\n其他城市 400 元" })]);
  expect(await repository.searchChunks({ vector, limit: 5 })).toEqual([expect.objectContaining({ sectionId: expect.any(String), content: "北京上海 600 元" })]);
  const [hit] = await repository.searchChunks({ vector, limit: 5 });
  expect(await repository.loadSections([hit.sectionId!])).toEqual([expect.objectContaining({ id: hit.sectionId, content: "北京上海 600 元\n其他城市 400 元", title: "差旅制度", canonicalUrl: source.canonicalUrl })]);
  await prisma.policySource.update({ where: { id: source.id }, data: { enabled: false } });
  expect(await repository.loadSections([hit.sectionId!])).toEqual([]);
});
