import { expect, it, vi } from "vitest";

import { syncPolicySource } from "@/src/application/sync-policy-source";
import { EmbeddingProviderError } from "@/src/infrastructure/embedding/embedding-provider";

const source = { id: "source-1", type: "FEISHU_DOCX" as const, resourceToken: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789", title: "差旅制度" };

it("activates a changed document only after all chunks are embedded", async () => {
  const stageSnapshot = vi.fn().mockResolvedValue({ id: "snapshot-1" });
  const activateSnapshot = vi.fn();
  const result = await syncPolicySource({ actorId: "admin-1", sourceId: source.id }, {
    sources: { getEnabledSourceForSync: async () => source, getLatestContentHash: async () => null, stageSnapshot, activateSnapshot, markSyncFailure: async () => undefined },
    documents: { read: async () => ({ title: "差旅制度", revision: "1", canonicalUrl: source.canonicalUrl, blocks: [{ kind: "heading" as const, text: "住宿" }, { kind: "paragraph" as const, text: "住宿上限 500 元" }] }) },
    embeddings: { embed: async () => [Array.from({ length: 1024 }, (_, i) => i ? 0 : 1)] },
    now: () => new Date("2026-09-27T00:00:00Z"),
  });
  expect(result).toEqual({ status: "SYNCED", chunkCount: 1 });
  expect(stageSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sourceId: source.id, chunks: [expect.objectContaining({ embedding: expect.any(Array) })] }));
  expect(activateSnapshot).toHaveBeenCalledWith({ sourceId: source.id, snapshotId: "snapshot-1", now: new Date("2026-09-27T00:00:00Z") });
});

it("embeds a long policy document in batches of at most 32 chunks", async () => {
  const embed = vi.fn(async ({ texts }: { texts: string[] }) => texts.map(() => Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)));
  const stageSnapshot = vi.fn().mockResolvedValue({ id: "snapshot-1" });
  const blocks = Array.from({ length: 33 }, (_, index) => ({ kind: "paragraph" as const, text: `第${index + 1}条${"A".repeat(80)}` }));

  await expect(syncPolicySource({ actorId: "admin-1", sourceId: source.id }, {
    sources: { getEnabledSourceForSync: async () => source, getLatestContentHash: async () => null, stageSnapshot, activateSnapshot: vi.fn(), markSyncFailure: vi.fn() },
    documents: { read: async () => ({ title: "差旅制度", revision: "1", canonicalUrl: source.canonicalUrl, blocks }) },
    embeddings: { embed }, now: () => new Date(),
  })).resolves.toEqual({ status: "SYNCED", chunkCount: 33 });

  expect(embed.mock.calls.map(([input]) => input.texts.length)).toEqual([32, 1]);
  expect(stageSnapshot).toHaveBeenCalledWith(expect.objectContaining({ chunks: expect.arrayContaining([expect.objectContaining({ embedding: expect.any(Array) })]) }));
});

it("retains the active snapshot when embedding fails", async () => {
  const activateSnapshot = vi.fn();
  const markSyncFailure = vi.fn();
  await expect(syncPolicySource({ actorId: "admin-1", sourceId: source.id }, {
    sources: { getEnabledSourceForSync: async () => source, getLatestContentHash: async () => null, stageSnapshot: vi.fn(), activateSnapshot, markSyncFailure },
    documents: { read: async () => ({ title: "差旅制度", revision: "1", canonicalUrl: source.canonicalUrl, blocks: [{ kind: "paragraph" as const, text: "住宿上限 500 元" }] }) },
    embeddings: { embed: async () => { throw new Error("offline"); } }, now: () => new Date(),
  })).rejects.toThrow("政策来源同步失败：SYNC_FAILED");
  expect(activateSnapshot).not.toHaveBeenCalled();
  expect(markSyncFailure).toHaveBeenCalledWith({ sourceId: source.id, code: "SYNC_FAILED" });
});

it("reports an embedding availability failure with a safe dependency code", async () => {
  const markSyncFailure = vi.fn();

  await expect(syncPolicySource({ actorId: "admin-1", sourceId: source.id }, {
    sources: { getEnabledSourceForSync: async () => source, getLatestContentHash: async () => null, stageSnapshot: vi.fn(), activateSnapshot: vi.fn(), markSyncFailure },
    documents: { read: async () => ({ title: "差旅制度", revision: "1", canonicalUrl: source.canonicalUrl, blocks: [{ kind: "paragraph" as const, text: "住宿上限 500 元" }] }) },
    embeddings: { embed: async () => { throw new EmbeddingProviderError("Embedding 服务暂不可用，请稍后重试。", "UNAVAILABLE"); } }, now: () => new Date(),
  })).rejects.toThrow("政策来源同步失败：EMBEDDING_UNAVAILABLE");

  expect(markSyncFailure).toHaveBeenCalledWith({ sourceId: source.id, code: "EMBEDDING_UNAVAILABLE" });
});
