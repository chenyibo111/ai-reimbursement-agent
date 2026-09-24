import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { extractReceipt } from "@/src/application/extract-receipt";
import { createPaddleOcrClient, createReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider-factory";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createS3ObjectStore } from "@/src/infrastructure/storage/object-store";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string; receiptId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId, receiptId } = await context.params;
    const prisma = getPrisma();
    const objects = createS3ObjectStore({
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET ?? "reimbursement-private",
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    });
    const providerName = process.env.RECEIPT_EXTRACTION_PROVIDER;
    const result = await extractReceipt(
      { actorId, claimId, receiptId },
      {
        claims: new PrismaClaimRepository(prisma),
        receipts: {
          async getByIdOrThrow(id, expectedClaimId) {
            const receipt = await prisma.receipt.findUnique({ where: { id }, include: { claim: { select: { employeeId: true } } } });
            if (!receipt || receipt.claimId !== expectedClaimId) throw new Error("receipt not found");
            return { ...receipt, employeeId: receipt.claim.employeeId };
          },
          async markExtracted(input) {
            await prisma.receipt.update({
              where: { id: input.receiptId },
              data: { status: "EXTRACTED", receiptType: input.extraction.receiptType, extractionPayload: input.payload as Prisma.InputJsonValue, extractionVersion: input.extraction.modelVersion ?? "unknown" },
            });
          },
          async markFailed(input) {
            await prisma.receipt.update({ where: { id: input.receiptId }, data: { status: "FAILED" } });
          },
          async hasDuplicateContentHash(input) {
            return Boolean(await prisma.receipt.findFirst({ where: { id: { not: input.receiptId }, contentHash: input.contentHash, expenseItem: { isNot: null } }, select: { id: true } }));
          },
          async hasSubmittedInvoiceNumber(input) {
            return Boolean(await prisma.expenseItem.findFirst({ where: { invoiceNumber: input.invoiceNumber, claim: { employeeId: input.employeeId, status: "SUBMITTED" }, receiptId: { not: input.receiptId } }, select: { id: true } }));
          },
        },
        expenses: { async create(input) { await prisma.expenseItem.create({ data: { ...input, amountSource: "EXTRACTED", issuedOnSource: input.issuedOn ? "EXTRACTED" : null, invoiceSource: input.invoiceNumber ? "EXTRACTED" : null } }); } },
        validations: { async create(input) { await prisma.validationResult.create({ data: { ...input, ruleVersion: "v1" } }); } },
        provider: createReceiptExtractionProvider({
          provider: providerName,
          environment: process.env.NODE_ENV,
          ocr: providerName === "paddleocr"
            ? createPaddleOcrClient({ objects, endpoint: process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8000" })
            : undefined,
        }),
        audit: createPrismaAuditEventWriter(prisma),
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "receipt not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
