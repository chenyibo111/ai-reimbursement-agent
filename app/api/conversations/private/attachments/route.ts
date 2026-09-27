import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { extractReceipt } from "@/src/application/extract-receipt";
import { preflightReceiptUpload, uploadReceipt } from "@/src/application/upload-receipt";
import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { createClamAvFileSafetyScanner } from "@/src/infrastructure/security/file-safety-scanner";
import { createS3ObjectStore } from "@/src/infrastructure/storage/object-store";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { createPaddleOcrClient, createReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider-factory";
import type { Prisma } from "@/generated/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaReceiptRepository } from "@/src/infrastructure/prisma/receipt-repository";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "file is required" }, { status: 400 });
    const attachment = { filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
    const prisma = getPrisma();
    const repository = new AgentConversationRepository(prisma);
    const conversation = await repository.getOrCreatePrivate(actorId);
    const scanner = createClamAvFileSafetyScanner(process.env.CLAMAV_HOST ?? "localhost", Number(process.env.CLAMAV_PORT ?? 3310));
    const claims = new PrismaClaimRepository(prisma);
    const audit = createPrismaAuditEventWriter(prisma);
    const objects = createS3ObjectStore({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET ?? "reimbursement-private", accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY });
    const result = await runConversationTurn(
      { actorId, conversationId: conversation.id, channel: "WEB", message: "上传票据", attachment },
      {
        conversations: repository as unknown as ConversationStore,
        model: createChatModel(loadConfig(process.env)),
        preflightAttachment: (input) => preflightReceiptUpload(input, scanner),
        createClaim: ({ actorId: claimActorId }) => createClaimDraft({ actorId: claimActorId }, { claims, audit }),
        uploadReceipt: (input) => uploadReceipt(input, { claims, receipts: new PrismaReceiptRepository(prisma), scanner, store: objects, audit }),
        extractReceipt: ({ actorId: extractionActorId, claimId, receiptId }) => extractUploadedReceipt({ prisma, actorId: extractionActorId, claimId, receiptId, objects, audit }),
      },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : ["file is required", "unsupported or oversized file", "file signature does not match declared type", "invalid PDF", "PDF exceeds 20 pages", "unsafe file"].includes(message) ? 400 : 500;
    return NextResponse.json({ error: status < 500 ? message : "request failed" }, { status });
  }
}

async function extractUploadedReceipt(input: {
  prisma: ReturnType<typeof createPrismaClient>;
  actorId: string;
  claimId: string;
  receiptId: string;
  objects: ReturnType<typeof createS3ObjectStore>;
  audit: ReturnType<typeof createPrismaAuditEventWriter>;
}) {
  const providerName = process.env.RECEIPT_EXTRACTION_PROVIDER;
  return extractReceipt(
    { actorId: input.actorId, claimId: input.claimId, receiptId: input.receiptId },
    {
      claims: new PrismaClaimRepository(input.prisma),
      receipts: {
        async getByIdOrThrow(id, expectedClaimId) {
          const receipt = await input.prisma.receipt.findUnique({ where: { id }, include: { claim: { select: { employeeId: true } } } });
          if (!receipt || receipt.claimId !== expectedClaimId) throw new Error("receipt not found");
          return { ...receipt, employeeId: receipt.claim.employeeId };
        },
        async markExtracted(result) { await input.prisma.receipt.update({ where: { id: result.receiptId }, data: { status: "EXTRACTED", receiptType: result.extraction.receiptType, extractionPayload: result.payload as Prisma.InputJsonValue, extractionVersion: result.extraction.modelVersion ?? "unknown" } }); },
        async markFailed(result) { await input.prisma.receipt.update({ where: { id: result.receiptId }, data: { status: "FAILED" } }); },
        async hasDuplicateContentHash(result) { return Boolean(await input.prisma.receipt.findFirst({ where: { id: { not: result.receiptId }, contentHash: result.contentHash, expenseItem: { isNot: null } }, select: { id: true } })); },
        async hasSubmittedInvoiceNumber(result) { return Boolean(await input.prisma.expenseItem.findFirst({ where: { invoiceNumber: result.invoiceNumber, claim: { employeeId: result.employeeId, status: "SUBMITTED" }, receiptId: { not: result.receiptId } }, select: { id: true } })); },
      },
      expenses: { async create(result) { await input.prisma.expenseItem.create({ data: { ...result, amountSource: "EXTRACTED", issuedOnSource: result.issuedOn ? "EXTRACTED" : null, invoiceSource: result.invoiceNumber ? "EXTRACTED" : null } }); } },
      validations: { async create(result) { await input.prisma.validationResult.create({ data: { ...result, ruleVersion: "v1" } }); } },
      provider: createReceiptExtractionProvider({ provider: providerName, environment: process.env.NODE_ENV, ocr: providerName === "paddleocr" ? createPaddleOcrClient({ objects: input.objects, endpoint: process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8000" }) : undefined }),
      audit: input.audit,
    },
  );
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
