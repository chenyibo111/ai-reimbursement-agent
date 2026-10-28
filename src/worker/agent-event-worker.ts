import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";

import { ReimbursementApiClient } from "../../services/agent/src/adapters/reimbursement-api-client";
import { AGENT_PROGRESS_EVENT_CONSUMER, AGENT_RECEIPT_EVENT_CONSUMER, ensureProgressConsumer, ensureReceiptExtractionConsumer, REIMBURSEMENT_EVENT_STREAM } from "../../services/agent/src/events/jetstream-durable-consumer";
import { consumeReceiptExtractionEvents } from "../../services/agent/src/events/jetstream-consumer";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { PrismaAgentProcessedEventRepository } from "@/src/infrastructure/prisma/agent-processed-event-repository";
import { createFeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";
import { createLogger } from "@/src/observability/logger";
import { validateFeishuWorkerEnvironment } from "@/src/server/config";
import { createAgentEventNotificationHandler } from "@/src/worker/agent-event-runtime";

const logger = createLogger("agent-event-worker");

async function main() {
  const bot = validateFeishuWorkerEnvironment(process.env);
  const databaseUrl = requiredEnv("DATABASE_URL");
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  const connection = await connect({ servers: process.env.NATS_URL?.trim() || "nats://nats:4222" });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await connection.close();
    await prisma.$disconnect();
    logger.info("worker.stopped", "Agent 事件 Worker 已停止");
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  try {
    const manager = await jetstreamManager(connection);
    await ensureReceiptExtractionConsumer(manager);
    await ensureProgressConsumer(manager);
    const streams = jetstream(connection);
    const [receiptConsumer, progressConsumer] = await Promise.all([
      streams.consumers.get(REIMBURSEMENT_EVENT_STREAM, AGENT_RECEIPT_EVENT_CONSUMER),
      streams.consumers.get(REIMBURSEMENT_EVENT_STREAM, AGENT_PROGRESS_EVENT_CONSUMER),
    ]);
    const port = new ReimbursementApiClient({
        baseUrl: requiredEnv("REIMBURSEMENT_API_URL"),
        serviceKey: requiredEnv("REIMBURSEMENT_AGENT_SERVICE_KEY"),
        signingSecret: requiredEnv("REIMBURSEMENT_AUTH_HS256_SECRET"),
    });
    const processedEvents = new PrismaAgentProcessedEventRepository(prisma, AGENT_RECEIPT_EVENT_CONSUMER);
    const conversations = new AgentConversationRepository(prisma);
    const client = createFeishuBotClient({ appId: bot.appId, appSecret: bot.appSecret });
    const common = { port, processedEvents, conversations, client, publicAppUrl: bot.publicAppUrl };
    const receiptHandler = createAgentEventNotificationHandler({ ...common, acceptedEventTypes: ["ReceiptExtractionCompleted"] });
    const progressHandler = createAgentEventNotificationHandler({ ...common, acceptedEventTypes: ["ReceiptReviewRequired", "ReceiptReviewResolved", "ClaimSubmitted"] });
    logger.info("worker.started", "Agent 事件 Worker 已启动", { status: "ready" });
    await Promise.all([
      consumeReceiptExtractionEvents({ consumer: receiptConsumer, handle: (event) => receiptHandler.handle(event), shouldContinue: () => !stopping }),
      consumeReceiptExtractionEvents({ consumer: progressConsumer, handle: (event) => progressHandler.handle(event), shouldContinue: () => !stopping }),
    ]);
  } finally {
    await shutdown();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  logger.error("worker.failed", "Agent 事件 Worker 启动或运行失败", {
    failureCode: error instanceof Error && error.message.includes("required") ? "configuration_missing" : "worker_failed",
  });
  process.exitCode = 1;
});
