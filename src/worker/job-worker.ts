import { runAsyncJobWorkerOnce } from "@/src/application/run-async-job-worker";
import { processAsyncJob } from "@/src/application/process-async-job";
import { extractReceipt } from "@/src/application/extract-receipt";
import { createExtractReceiptDeps } from "@/src/application/create-extract-receipt-deps";
import { syncPolicySource } from "@/src/application/sync-policy-source";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createFeishuPolicyDocumentClient } from "@/src/infrastructure/feishu/feishu-policy-document-client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { loadConfig } from "@/src/server/config";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createLogger } from "@/src/observability/logger";
import { createWorkerHeartbeat } from "@/src/observability/worker-heartbeat";

const pollIntervalMs = Number(process.env.JOB_WORKER_POLL_INTERVAL_MS ?? 1_000);
const logger = createLogger("job-worker");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) throw new Error("JOB_WORKER_POLL_INTERVAL_MS must be an integer of at least 100");
  const prisma = createPrismaClient(databaseUrl);
  const jobs = new PrismaAsyncJobRepository(prisma);
  const extractDeps = createExtractReceiptDeps(prisma);
  const heartbeat = createWorkerHeartbeat(logger);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await prisma.$connect();
    logger.info("worker.started", "异步任务 Worker 已启动");
    while (!stopping) {
      heartbeat.emitIfDue();
      const processed = await runAsyncJobWorkerOnce({
        jobs,
        process: (job) => processAsyncJob(job, {
          jobs,
          extractReceipt: (input) => extractReceipt(input, extractDeps),
          syncPolicySource: async ({ actorId, sourceId }) => {
            const config = loadConfig(process.env);
            if (!config.feishuOAuth || !config.embedding) throw new Error("policy sync configuration is incomplete");
            return syncPolicySource({ actorId, sourceId }, {
              sources: new PrismaPolicyKnowledgeRepository(prisma),
              documents: createFeishuPolicyDocumentClient({ appId: config.feishuOAuth.appId, appSecret: config.feishuOAuth.appSecret }),
              embeddings: createEmbeddingProvider(config),
              now: () => new Date(),
            });
          },
        }),
        now: () => new Date(),
        leaseMs: 60_000,
        logger,
      });
      if (!processed) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } finally {
    logger.info("worker.stopped", "异步任务 Worker 已停止");
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  logger.error("worker.failed", "异步任务 Worker 意外退出", { failureCode: "worker_failed" });
  process.exitCode = 1;
});
