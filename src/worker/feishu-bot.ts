import * as lark from "@larksuiteoapi/node-sdk";

import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";
import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { searchPolicyKnowledge } from "@/src/application/search-policy-knowledge";
import { createAgentReimbursementRuntime } from "@/src/agent/reimbursement-runtime";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createFeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { FeishuBotRepository } from "@/src/infrastructure/prisma/feishu-bot-repository";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { createLogger } from "@/src/observability/logger";
import { createWorkerHeartbeat } from "@/src/observability/worker-heartbeat";
import { loadConfig, validateFeishuWorkerEnvironment } from "@/src/server/config";
import { createFeishuIdentityEnsurer } from "@/src/server/employee-identity";
import { createFeishuBotRuntime } from "@/src/worker/feishu-bot-runtime";

const logger = createLogger("feishu-worker");

async function main() {
  const bot = validateFeishuWorkerEnvironment(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database configuration is missing");
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  const repository = new FeishuBotRepository(prisma);
  const recovery = await repository.recoverProcessingEvents();
  if (recovery.recovered) logger.warn("reply.delivery.recovered", "已恢复未完成的飞书事件", { count: recovery.recovered });
  if (recovery.uncertainDeliveryFailed) logger.error("reply.delivery.failed", "飞书回复结果无法确认，已停止自动重试", { count: recovery.uncertainDeliveryFailed, failureCode: "DELIVERY_OUTCOME_UNKNOWN" });
  const client = createFeishuBotClient({ appId: bot.appId, appSecret: bot.appSecret });
  let wsClient: lark.WSClient | undefined;
  const processDeps = createProcessDeps({ prisma, botOpenId: bot.botOpenId, publicAppUrl: bot.publicAppUrl, repository, client });
  const runtime = createFeishuBotRuntime({
    repository,
    processEvent: (input) => processFeishuEvent(input, processDeps),
    replyText: (messageId, text, uuid) => client.replyText(messageId, text, uuid),
    onReplyDelivery: ({ status, attempt, failureCode }) => {
      if (status === "delivered") logger.info("reply.delivery.completed", "飞书回复已投递", { attempt });
      else if (status === "retrying") logger.warn("reply.delivery.retrying", "飞书回复投递失败，等待重试", { attempt, failureCode });
      else logger.error("reply.delivery.failed", "飞书回复投递已达到终止条件", { attempt, failureCode });
    },
    closeConnection: async () => wsClient?.close({ force: true }),
  });
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error });
  dispatcher.register({ "im.message.receive_v1": (event) => runtime.onEvent(event) });
  wsClient = new lark.WSClient({ appId: bot.appId, appSecret: bot.appSecret, autoReconnect: true, loggerLevel: lark.LoggerLevel.error });
  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info("worker.started", "飞书机器人 Worker 已启动");
  const heartbeat = createWorkerHeartbeat(logger, { message: "飞书机器人 Worker 心跳正常" });
  let lastRecoveryAt = Date.now();
  const interval = setInterval(() => {
    heartbeat.emitIfDue();
    if (Date.now() - lastRecoveryAt >= 60_000) {
      lastRecoveryAt = Date.now();
      void repository.recoverProcessingEvents(new Date(Date.now() - 2 * 60_000)).then(({ recovered, uncertainDeliveryFailed }) => {
        if (recovered) logger.warn("reply.delivery.recovered", "已恢复超时的飞书事件", { count: recovered });
        if (uncertainDeliveryFailed) logger.error("reply.delivery.failed", "飞书回复结果无法确认，已停止自动重试", { count: uncertainDeliveryFailed, failureCode: "DELIVERY_OUTCOME_UNKNOWN" });
      }).catch(() => logger.error("event.recovery.failed", "飞书事件恢复检查失败", { failureCode: "RECOVERY_FAILED" }));
    }
    void runtime.drainOnce().catch(() => logger.warn("event.drain.failed", "飞书事件队列处理失败", { failureCode: "event_drain_failed" }));
  }, 800);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await runtime.stop();
    await prisma.$disconnect();
    logger.info("worker.stopped", "飞书机器人 Worker 已停止");
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

function createProcessDeps(input: {
  prisma: ReturnType<typeof createPrismaClient>;
  botOpenId: string;
  publicAppUrl: string;
  repository: FeishuBotRepository;
  client: ReturnType<typeof createFeishuBotClient>;
}): ProcessFeishuEventDeps {
  const config = loadConfig(process.env);
  const conversations = new AgentConversationRepository(input.prisma);
  const tools = createAgentReimbursementRuntime(input.prisma, process.env, fetch, "feishu-worker");
  const ensureFeishuIdentity = createFeishuIdentityEnsurer(input.prisma);
  return {
    botOpenId: input.botOpenId,
    publicAppUrl: input.publicAppUrl,
    events: input.repository,
    identities: { ensureEmployeeForInboundMessage: async ({ openId, displayName }) => {
      const employee = await ensureFeishuIdentity({ openId, displayName });
      return { id: employee.id, role: employee.role };
    } },
    conversations,
    client: input.client,
    runConversationTurn: (agentInput) => {
      const context = { actorId: agentInput.actorId, actorRole: agentInput.actorRole, channel: "FEISHU" as const, conversationId: agentInput.conversationId, turnId: agentInput.channelMessageId };
      return runConversationTurn(agentInput, {
        conversations: conversations as unknown as ConversationStore,
        model: createChatModel(config),
        searchPolicy: config.embedding ? (query) => searchPolicyKnowledge({ query, limit: 5 }, {
          embeddings: createEmbeddingProvider(config),
          chunks: new PrismaPolicyKnowledgeRepository(input.prisma),
        }) : undefined,
        preflightAttachment: async () => {},
        createClaim: ({ purpose }) => tools.createClaim(context, purpose),
        uploadReceipt: async (receiptInput) => {
          const receipt = await tools.uploadReceipt(context, receiptInput.claimId, { filename: receiptInput.filename, mimeType: receiptInput.mimeType, bytes: receiptInput.bytes });
          return { id: receipt.receiptId };
        },
        updateFields: ({ claimId, fields }) => tools.updateFields(context, claimId, fields),
        readWorkbench: ({ claimId }) => tools.readWorkbench(context, claimId),
        deleteReceipt: ({ claimId, receiptId, expectedClaimVersion }) => tools.deleteReceipt(context, claimId, receiptId, expectedClaimVersion),
        deleteDraft: ({ claimId, expectedClaimVersion }) => tools.deleteDraft(context, claimId, expectedClaimVersion),
        listOwnedClaims: ({ limit }) => tools.listOwnedClaims(context, limit),
        searchOwnedClaims: ({ query }) => tools.searchOwnedClaims(context, query),
        findOwnedClaimByNumber: ({ claimNumber }) => tools.findOwnedClaimByNumber(context, claimNumber),
        readValidation: ({ claimId }) => tools.readValidation(context, claimId),
        readProgress: ({ claimId }) => tools.readProgress(context, claimId),
        prepareSubmission: async ({ claimId }) => {
          const confirmation = await tools.prepareSubmission(context, claimId);
          return { token: confirmation.confirmationToken, claimId: confirmation.claimId, claimVersion: confirmation.claimVersion, workbench: confirmation.workbench };
        },
        submitClaim: async ({ claimId, confirmationToken }) => {
          const submission = await tools.submit(context, claimId, confirmationToken);
          return { submissionNumber: submission.submissionNumber };
        },
      });
    },
  };
}

void main().catch(() => {
  logger.error("worker.failed", "飞书机器人 Worker 启动或运行失败", { failureCode: "worker_failed" });
  process.exitCode = 1;
});
