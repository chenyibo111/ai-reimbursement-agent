import { syncPolicySource } from "@/src/application/sync-policy-source";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createFeishuPolicyDocumentClient } from "@/src/infrastructure/feishu/feishu-policy-document-client";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { loadConfig } from "@/src/server/config";

async function main() {
  const sourceId = process.argv[2];
  if (!sourceId) throw new Error("policy source id is required");
  const databaseUrl = process.env.DATABASE_URL;
  const config = loadConfig(process.env);
  if (!databaseUrl || !config.feishuOAuth || !config.embedding) throw new Error("policy sync configuration is incomplete");
  const prisma = createPrismaClient(databaseUrl);
  try {
    await prisma.$connect();
    const result = await syncPolicySource({ actorId: "policy-sync-worker", sourceId }, {
      sources: new PrismaPolicyKnowledgeRepository(prisma),
      documents: createFeishuPolicyDocumentClient({ appId: config.feishuOAuth.appId, appSecret: config.feishuOAuth.appSecret }),
      embeddings: createEmbeddingProvider(config), now: () => new Date(),
    });
    console.log(JSON.stringify({ status: result.status, chunkCount: result.chunkCount }));
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error("Policy sync worker failed"); process.exitCode = 1; });
