import { createHash, randomUUID } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import { recordAuditEvent, type AuditEventWriter } from "@/src/application/audit-event";
import type { Receipt } from "@/src/domain/receipt";
import type { FileSafetyScanner } from "@/src/infrastructure/security/file-safety-scanner";
import type { ObjectStore } from "@/src/infrastructure/storage/object-store";
import { assertClaimOwner } from "@/src/server/authorization";

const maxBytes = 20 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);

export type UploadReceiptInput = {
  actorId: string;
  claimId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type UploadReceiptDeps = {
  claims: { getByIdOrThrow(id: string): Promise<{ employeeId: string }> };
  receipts: { create(input: Receipt): Promise<Receipt> };
  store: ObjectStore;
  scanner: FileSafetyScanner;
  audit: AuditEventWriter;
};

export async function uploadReceipt(input: UploadReceiptInput, deps: UploadReceiptDeps): Promise<Receipt> {
  const claim = await deps.claims.getByIdOrThrow(input.claimId);
  assertClaimOwner(input.actorId, claim);
  validateSizeAndMime(input);
  validateFileSignature(input.mimeType, input.bytes);
  if (input.mimeType === "application/pdf") await validatePdf(input.bytes);

  if ((await deps.scanner.scan(input.bytes)) !== "CLEAN") {
    throw new Error("unsafe file");
  }

  const id = randomUUID();
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const objectKey = `claims/${input.claimId}/receipts/${id}/${contentHash}`;
  await deps.store.put({ key: objectKey, bytes: input.bytes, mimeType: input.mimeType });
  const receipt = await deps.receipts.create({
    id,
    claimId: input.claimId,
    objectKey,
    contentHash,
    mimeType: input.mimeType,
    status: "PENDING",
  });
  await recordAuditEvent(
    {
      type: "RECEIPT_UPLOADED",
      actorId: input.actorId,
      claimId: input.claimId,
      payload: { receiptId: receipt.id, filename: input.filename, contentHash },
    },
    deps.audit,
  );

  return receipt;
}

function validateSizeAndMime(input: Pick<UploadReceiptInput, "mimeType" | "bytes">): void {
  if (!allowedMimeTypes.has(input.mimeType) || input.bytes.byteLength > maxBytes) {
    throw new Error("unsupported or oversized file");
  }
}

function validateFileSignature(mimeType: string, bytes: Uint8Array): void {
  const matches =
    (mimeType === "application/pdf" && startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) ||
    (mimeType === "image/jpeg" && startsWith(bytes, [0xff, 0xd8, 0xff])) ||
    (mimeType === "image/png" && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!matches) throw new Error("file signature does not match declared type");
}

async function validatePdf(bytes: Uint8Array): Promise<void> {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
    if (pdf.getPageCount() > 20) throw new Error("PDF exceeds 20 pages");
  } catch (error) {
    if (error instanceof Error && error.message === "PDF exceeds 20 pages") throw error;
    throw new Error("invalid PDF");
  }
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}
