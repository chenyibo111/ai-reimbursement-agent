import * as lark from "@larksuiteoapi/node-sdk";

import type { Prisma } from "@/generated/prisma/client";
import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { buildAgentContext } from "@/src/application/build-agent-context";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { extractReceipt } from "@/src/application/extract-receipt";
import { getClaimSummary } from "@/src/application/get-claim-summary";
import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";
import { runAgentTurn } from "@/src/application/run-agent-turn";
import { uploadReceipt } from "@/src/application/upload-receipt";
import { formatProposalValue, type AgentProposalField } from "@/src/domain/agent-proposal";
import { createReceiptExtractionProvider, createPaddleOcrClient } from "@/src/infrastructure/extraction/receipt-extraction-provider-factory";
import { createFeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { FeishuBotRepository } from "@/src/infrastructure/prisma/feishu-bot-repository";
import { PrismaReceiptRepository } from "@/src/infrastructure/prisma/receipt-repository";
import { createClamAvFileSafetyScanner } from "@/src/infrastructure/security/file-safety-scanner";
import { createS3ObjectStore } from "@/src/infrastructure/storage/object-store";
import { loadConfig, validateFeishuWorkerEnvironment } from "@/src/server/config";
import { validateStoredClaim } from "@/src/server/stored-claim-validation";
import { createFeishuBotRuntime } from "@/src/worker/feishu-bot-runtime";

async function main() {
  const bot = validateFeishuWorkerEnvironment(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database configuration is missing");

  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  const repository = new FeishuBotRepository(prisma);
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

  const interval = setInterval(() => { void runtime.drainOnce(); }, 800);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await runtime.stop();
    await prisma.$disconnect();
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
  const claims = new PrismaClaimRepository(input.prisma);
  const audit = createPrismaAuditEventWriter(input.prisma);
  const objects = createS3ObjectStore({
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET ?? "reimbursement-private",
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });

  return {
    botOpenId: input.botOpenId,
    publicAppUrl: input.publicAppUrl,
    events: input.repository,
    client: input.client,
    createClaimDraft: (claimInput) => createClaimDraft(claimInput, { claims, audit }),
    runAgentTurn: (agentInput) => runAgentTurn(agentInput, {
      model: createChatModel(loadConfig(process.env)),
      getContext: async (actorId, claimId) => {
        const summary = await getClaimSummary(actorId, claimId, { claims });
        const draft = await input.prisma.claimDraft.findUnique({ where: { id: claimId }, include: { receipts: true, expenseItems: true, validationResults: true } });
        if (!draft) throw new Error("claim not found");
        return buildAgentContext({
          claim: { version: draft.version, purpose: draft.purpose, totalAmountCents: summary.totalAmountCents, expenseItems: draft.expenseItems, receipts: draft.receipts },
          issues: validateStoredClaim(draft),
        });
      },
      createProposal: async (proposal) => {
        const saved = await input.prisma.agentFieldProposal.create({
          data: {
            claimId: proposal.claimId,
            expenseItemId: proposal.expenseItemId,
            targetRef: proposal.target,
            field: proposal.field,
            value: proposal.value as Prisma.InputJsonValue,
            reason: proposal.reason,
            claimVersion: proposal.claimVersion,
          },
        });
        await audit.append({ type: "AGENT_FIELD_PROPOSED", actorId: proposal.actorId, claimId: proposal.claimId, payload: { proposalId: saved.id, field: saved.field } });
        return { id: saved.id, target: saved.targetRef, field: saved.field, displayValue: formatProposalValue({ field: saved.field as AgentProposalField, value: saved.value as string | number }), reason: saved.reason, status: saved.status, claimVersion: saved.claimVersion };
      },
      audit,
    }),
    uploadReceipt: (receiptInput) => uploadReceipt(receiptInput, {
      claims,
      receipts: new PrismaReceiptRepository(input.prisma),
      audit,
      scanner: createClamAvFileSafetyScanner(process.env.CLAMAV_HOST ?? "localhost", Number(process.env.CLAMAV_PORT ?? 3310)),
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
        async markExtracted(result) {
          await input.prisma.receipt.update({ where: { id: result.receiptId }, data: { status: "EXTRACTED", receiptType: result.extraction.receiptType, extractionPayload: result.payload as Prisma.InputJsonValue, extractionVersion: result.extraction.modelVersion ?? "unknown" } });
        },
        async markFailed(result) { await input.prisma.receipt.update({ where: { id: result.receiptId }, data: { status: "FAILED" } }); },
        async hasDuplicateContentHash(result) { return Boolean(await input.prisma.receipt.findFirst({ where: { id: { not: result.receiptId }, contentHash: result.contentHash, expenseItem: { isNot: null } }, select: { id: true } })); },
        async hasSubmittedInvoiceNumber(result) { return Boolean(await input.prisma.expenseItem.findFirst({ where: { invoiceNumber: result.invoiceNumber, claim: { employeeId: result.employeeId, status: "SUBMITTED" }, receiptId: { not: result.receiptId } }, select: { id: true } })); },
      },
      expenses: { async create(expense) { await input.prisma.expenseItem.create({ data: { ...expense, amountSource: "EXTRACTED", issuedOnSource: expense.issuedOn ? "EXTRACTED" : null, invoiceSource: expense.invoiceNumber ? "EXTRACTED" : null } }); } },
      validations: { async create(validation) { await input.prisma.validationResult.create({ data: { ...validation, ruleVersion: "v1" } }); } },
      provider: createReceiptExtractionProvider({
        provider: process.env.RECEIPT_EXTRACTION_PROVIDER,
        environment: process.env.NODE_ENV,
        ocr: process.env.RECEIPT_EXTRACTION_PROVIDER === "paddleocr" ? createPaddleOcrClient({ objects, endpoint: process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8000" }) : undefined,
      }),
      audit,
    }),
  };
}

void main().catch((error: unknown) => {
  const message = error instanceof Error && error.message === "FEISHU_BOT_ENABLED=true is required to start the Feishu worker"
    ? error.message
    : "Feishu bot worker failed to start";
  console.error(message);
  process.exitCode = 1;
});
