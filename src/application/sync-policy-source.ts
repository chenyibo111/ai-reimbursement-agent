import { createHash } from "node:crypto";

import { buildPolicySections } from "@/src/application/build-policy-sections";
import { splitPolicyDocument } from "@/src/application/split-policy-document";
import { EmbeddingProviderError, MAX_EMBEDDING_BATCH_SIZE, type EmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider";
import { FeishuPolicyDocumentClientError, type FeishuPolicyDocumentClient, type PolicyDocumentBlock } from "@/src/infrastructure/feishu/feishu-policy-document-client";

type SyncSource = { id: string; type: "FEISHU_DOCX" | "FEISHU_WIKI"; resourceToken: string; canonicalUrl: string; title: string };
type SyncRepository = {
  getEnabledSourceForSync(id: string): Promise<SyncSource | null>;
  getLatestContentHash(sourceId: string): Promise<string | null>;
  getLatestIndexState?(sourceId: string): Promise<{ contentHash: string; indexVersion: number } | null>;
  stageSnapshot(input: { sourceId: string; revision: string; contentHash: string; title: string; blocks: PolicyDocumentBlock[]; indexVersion: number; sections: ReturnType<typeof buildPolicySections>; chunks: Array<{ sequence: number; sectionSequence: number; content: string; headingPath: string[]; sourceAnchor: string | null; embedding: number[] }> }): Promise<{ id: string }>;
  activateSnapshot(input: { sourceId: string; snapshotId: string; now: Date }): Promise<void>;
  markSyncFailure(input: { sourceId: string; code: string }): Promise<void>;
};

export class PolicySourceSyncError extends Error {
  constructor(readonly code: string) {
    super(`政策来源同步失败：${code}`);
    this.name = "PolicySourceSyncError";
  }
}

export async function syncPolicySource(input: { actorId: string; sourceId: string }, deps: { sources: SyncRepository; documents: FeishuPolicyDocumentClient; embeddings: EmbeddingProvider; now: () => Date }) {
  const source = await deps.sources.getEnabledSourceForSync(input.sourceId);
  if (!source) throw new Error("policy source is unavailable");
  try {
    const document = await deps.documents.read({ type: source.type, token: source.resourceToken, canonicalUrl: source.canonicalUrl, title: source.title });
    const contentHash = createHash("sha256").update(JSON.stringify(document.blocks)).digest("hex");
    const latest = deps.sources.getLatestIndexState ? await deps.sources.getLatestIndexState(source.id) : { contentHash: await deps.sources.getLatestContentHash(source.id), indexVersion: 1 };
    if (contentHash === latest?.contentHash && latest.indexVersion === 2) return { status: "UNCHANGED" as const, sectionCount: 0, chunkCount: 0 };
    const sections = buildPolicySections(document.blocks);
    const chunks = splitPolicyDocument(sections, { targetLength: 600, maxLength: 800 });
    if (!chunks.length) throw new Error("EMPTY_DOCUMENT");
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += MAX_EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + MAX_EMBEDDING_BATCH_SIZE);
      vectors.push(...await deps.embeddings.embed({ texts: batch.map((chunk) => chunk.content) }));
    }
    const snapshot = await deps.sources.stageSnapshot({ sourceId: source.id, revision: document.revision, contentHash, title: document.title, blocks: document.blocks, indexVersion: 2, sections, chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index]! })) });
    await deps.sources.activateSnapshot({ sourceId: source.id, snapshotId: snapshot.id, now: deps.now() });
    return { status: "SYNCED" as const, sectionCount: sections.length, chunkCount: chunks.length };
  } catch (error) {
    const code = failureCode(error);
    await deps.sources.markSyncFailure({ sourceId: source.id, code });
    throw new PolicySourceSyncError(code);
  }
}

function failureCode(error: unknown): string {
  if (error instanceof FeishuPolicyDocumentClientError) return `DOCUMENT_${error.code}`;
  if (error instanceof EmbeddingProviderError) return `EMBEDDING_${error.code}`;
  if (error instanceof Error && error.message === "EMPTY_DOCUMENT") return "EMPTY_DOCUMENT";
  return "SYNC_FAILED";
}
