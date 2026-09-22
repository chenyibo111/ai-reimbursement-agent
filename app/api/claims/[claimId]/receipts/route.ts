import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { uploadReceipt } from "@/src/application/upload-receipt";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaReceiptRepository } from "@/src/infrastructure/prisma/receipt-repository";
import { createClamAvFileSafetyScanner } from "@/src/infrastructure/security/file-safety-scanner";
import { createS3ObjectStore } from "@/src/infrastructure/storage/object-store";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const prisma = getPrisma();
    const receipt = await uploadReceipt(
      {
        actorId,
        claimId,
        filename: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
      {
        claims: new PrismaClaimRepository(prisma),
        receipts: new PrismaReceiptRepository(prisma),
        audit: createPrismaAuditEventWriter(prisma),
        scanner: createClamAvFileSafetyScanner(process.env.CLAMAV_HOST ?? "localhost", Number(process.env.CLAMAV_PORT ?? 3310)),
        store: createS3ObjectStore({
          endpoint: process.env.S3_ENDPOINT,
          bucket: process.env.S3_BUCKET ?? "reimbursement-private",
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }),
      },
    );

    return NextResponse.json(receipt, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : isInputError(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function getPrisma() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database configuration is missing");
  return createPrismaClient(connectionString);
}

function isInputError(message: string): boolean {
  return ["file is required", "unsupported or oversized file", "file signature does not match declared type", "invalid PDF", "PDF exceeds 20 pages", "unsafe file"].includes(message);
}
