import * as lark from "@larksuiteoapi/node-sdk";

import type { Prisma } from "@/generated/prisma/client";
import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { deliverReceiptExtractionNotificationOnce } from "@/src/application/deliver-receipt-extraction-notifications";
import { extractReceipt } from "@/src/application/extract-receipt";
import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";
import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { searchPolicyKnowledge } from "@/src/application/search-policy-knowledge";
import { preflightReceiptUpload, uploadReceipt } from "@/src/application/upload-receipt";
import { updateClaimField } from "@/src/application/update-claim-field";
import { requestStoredSubmission, submitStoredClaim } from "@/src/application/stored-submission";
import { createReceiptExtractionProvider, createPaddleOcrClient } from "@/src/infrastructure/extraction/receipt-extraction-provider-factory";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createFeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { FeishuBotRepository } from "@/src/infrastructure/prisma/feishu-bot-repository";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { PrismaReceiptRepository } from "@/src/infrastructure/prisma/receipt-repository";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { ReceiptExtractionNotificationRepository } from "@/src/infrastructure/prisma/receipt-extraction-notification-repository";
import { createClamAvFileSafetyScanner } from "@/src/infrastructure/security/file-safety-scanner";
import { createS3ObjectStore } from "@/src/infrastructure/storage/object-store";
import { createLogger } from "@/src/observability/logger";
import { createWorkerHeartbeat } from "@/src/observability/worker-heartbeat";
import { PrismaAgentToolCallRepository } from "@/src/infrastructure/prisma/agent-tool-call-repository";
import { loadConfig, validateFeishuWorkerEnvironment } from "@/src/server/config";
import { createFeishuIdentityEnsurer } from "@/src/server/employee-identity";
import { createFeishuBotRuntime } from "@/src/worker/feishu-bot-runtime";
import { ReimbursementApiClient } from "../../services/agent/src/adapters/reimbursement-api-client";
import { createConversationReimbursementTools } from "../../services/agent/src/tool-gateway/conversation-reimbursement";
import { ReimbursementToolGateway } from "../../services/agent/src/tool-gateway/reimbursement-tools";

const logger = createLogger("feishu-worker");

async function main() {
  const bot = validateFeishuWorkerEnvironment(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database configuration is missing");

  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  const repository = new FeishuBotRepository(prisma);
  const notificationRepository = new ReceiptExtractionNotificationRepository(prisma);
  const conversations = new AgentConversationRepository(prisma);
  await repository.recoverProcessingEvents();
  const client = createFeishuBotClient({ appId: bot.appId, appSecret: bot.appSecret });
  let wsClient: lark.WSClient | undefined;
  const processDeps = createProcessDeps({ prisma, botOpenId: bot.botOpenId, publicAppUrl: bot.publicAppUrl, repository, client });
  const runtime = createFeishuBotRuntime({
    repository,
    processEvent: (input) => processFeishuEvent(input, processDeps),
    replyText: (messageId, text) => client.replyText(messageId, text),
    closeConnection: async () => wsClient?.close({ force: true }),
  });

  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error });
  dispatcher.register({ "im.message.receive_v1": (event) => runtime.onEvent(event) });
  wsClient = new lark.WSClient({ appId: bot.appId, appSecret: bot.appSecret, autoReconnect: true, loggerLevel: lark.LoggerLevel.error });
  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info("worker.started", "飞书机器人 Worker 已启动");
  const heartbeat = createWorkerHeartbeat(logger, { message: "飞书机器人 Worker 心跳正常" });

  const drainNotifications = () => deliverReceiptExtractionNotificationOnce({
    notifications: notificationRepository,
    client,
    conversations,
    publicAppUrl: bot.publicAppUrl,
    now: () => new Date(),
    leaseMs: 30_000,
  });
  const interval = setInterval(() => {
    heartbeat.emitIfDue();
    void runtime.drainOnce().catch(() => {
      logger.warn("event.drain.failed", "飞书事件队列处理失败", { failureCode: "event_drain_failed" });
    });
    void drainNotifications().catch(() => {
      logger.warn("notification.drain.failed", "票据识别通知处理失败", { failureCode: "notification_drain_failed" });
    });
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
  const claims = new PrismaClaimRepository(input.prisma);
  const audit = createPrismaAuditEventWriter(input.prisma);
  const objects = createS3ObjectStore({
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET ?? "reimbursement-private",
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });
  const conversations = new AgentConversationRepository(input.prisma);
  const scanner = createClamAvFileSafetyScanner(process.env.CLAMAV_HOST ?? "localhost", Number(process.env.CLAMAV_PORT ?? 3310));
  const receipts = new PrismaReceiptRepository(input.prisma);
  const notifications = new ReceiptExtractionNotificationRepository(input.prisma);
  const useGoReimbursement = process.env.REIMBURSEMENT_AGENT_MODE === "go-api";
  const gateway = useGoReimbursement
    ? new ReimbursementToolGateway(new ReimbursementApiClient({
      baseUrl: requiredEnv("REIMBURSEMENT_API_URL"), serviceKey: requiredEnv("REIMBURSEMENT_AGENT_SERVICE_KEY"), signingSecret: requiredEnv("REIMBURSEMENT_AUTH_HS256_SECRET"),
    }), new PrismaAgentToolCallRepository(input.prisma))
    : null;
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
      const goTools = gateway ? createConversationReimbursementTools(gateway, fetch, process.env.REIMBURSEMENT_AGENT_STORAGE_ENDPOINT) : null;
      const context = { actorId: agentInput.actorId, actorRole: agentInput.actorRole, conversationId: agentInput.conversationId, channelMessageId: agentInput.channelMessageId };
      return runConversationTurn(agentInput, {
      conversations: conversations as unknown as ConversationStore,
      model: createChatModel(config),
      searchPolicy: config.embedding ? (query) => searchPolicyKnowledge({ query, limit: 5 }, {
        embeddings: createEmbeddingProvider(config),
        chunks: new PrismaPolicyKnowledgeRepository(input.prisma),
      }) : undefined,
      preflightAttachment: (attachment) => preflightReceiptUpload(attachment, scanner),
      createClaim: ({ actorId, purpose }) => goTools ? goTools.createClaim({ ...context, actorId }, purpose) : createClaimDraft({ actorId, purpose }, { claims, audit }),
      uploadReceipt: (receiptInput) => goTools ? goTools.uploadReceipt(context, receiptInput.claimId, { filename: receiptInput.filename, mimeType: receiptInput.mimeType, bytes: receiptInput.bytes }).then((receipt) => ({ id: receipt.receiptId })) : uploadReceipt(receiptInput, {
        claims,
        receipts,
        jobs: new PrismaAsyncJobRepository(input.prisma),
        notifications,
        audit,
        scanner,
        store: objects,
      }),
      extractReceipt: (extractInput) => extractReceipt(extractInput, {
        claims,
        receipts: {
          async getByIdOrThrow(id, claimId) {
            const receipt = await input.prisma.receipt.findUnique({ where: { id }, include: { claim: { select: { employeeId: true } } } });
            if (!receipt || receipt.claimId !== claimId) throw new Error("receipt not found");
            return { ...receipt, employeeId: receipt.claim.employeeId };
          },
          async markExtracted(result) { await input.prisma.receipt.update({ where: { id: result.receiptId }, data: { status: "EXTRACTED", receiptType: result.extraction.receiptType, extractionPayload: result.payload as Prisma.InputJsonValue, extractionVersion: result.extraction.modelVersion ?? "unknown" } }); },
          async markFailed(result) { await input.prisma.receipt.update({ where: { id: result.receiptId }, data: { status: "FAILED" } }); },
          async hasDuplicateContentHash(result) { return Boolean(await input.prisma.receipt.findFirst({ where: { id: { not: result.receiptId }, contentHash: result.contentHash, expenseItem: { isNot: null } }, select: { id: true } })); },
          async hasSubmittedInvoiceNumber(result) { return Boolean(await input.prisma.expenseItem.findFirst({ where: { invoiceNumber: result.invoiceNumber, claim: { employeeId: result.employeeId, status: "SUBMITTED" }, receiptId: { not: result.receiptId } }, select: { id: true } })); },
        },
        expenses: { async create(expense) { await input.prisma.expenseItem.create({ data: { ...expense, amountSource: "EXTRACTED", issuedOnSource: expense.issuedOn ? "EXTRACTED" : null, invoiceSource: expense.invoiceNumber ? "EXTRACTED" : null } }); } },
        validations: { async create(validation) { await input.prisma.validationResult.create({ data: { ...validation, ruleVersion: "v1" } }); } },
        provider: createReceiptExtractionProvider({ provider: process.env.RECEIPT_EXTRACTION_PROVIDER, environment: process.env.NODE_ENV, ocr: process.env.RECEIPT_EXTRACTION_PROVIDER === "paddleocr" ? createPaddleOcrClient({ objects, endpoint: process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8000" }) : undefined }),
        audit,
      }),
      updatePurpose: async ({ actorId, claimId, value }) => {
        if (goTools) return goTools.updatePurpose({ ...context, actorId }, claimId, value);
        const claim = await claims.getByIdOrThrow(claimId);
        const updated = await updateClaimField({ actorId, claimId, expectedVersion: claim.version, field: "purpose", value }, { claims, audit });
        return { version: updated.version };
      },
      requestSubmission: async ({ actorId, claimId }) => {
        if (goTools) { const confirmation = await goTools.requestSubmission({ ...context, actorId }, claimId); return { token: confirmation.confirmationToken, claimId: confirmation.claimId, claimVersion: confirmation.claimVersion }; }
        return requestStoredSubmission({ prisma: input.prisma, actorId, claimId });
      },
      submitClaim: async ({ actorId, claimId, confirmationToken }) => {
        if (goTools) { const submission = await goTools.submit({ ...context, actorId }, claimId, confirmationToken); return { submissionNumber: submission.submissionNumber }; }
        return submitStoredClaim({ prisma: input.prisma, actorId, claimId, confirmationToken });
      },
    });
    },
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when REIMBURSEMENT_AGENT_MODE=go-api`);
  return value;
}

void main().catch(() => {
  logger.error("worker.failed", "飞书机器人 Worker 启动或运行失败", { failureCode: "worker_failed" });
  process.exitCode = 1;
});
