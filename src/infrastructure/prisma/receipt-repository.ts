import type { PrismaClient } from "@/generated/prisma/client";
import type { Receipt } from "@/src/domain/receipt";

export class PrismaReceiptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: Receipt): Promise<Receipt> {
    const receipt = await this.prisma.receipt.create({ data: input });
    return {
      id: receipt.id,
      claimId: receipt.claimId,
      objectKey: receipt.objectKey,
      originalFilename: receipt.originalFilename ?? "",
      contentHash: receipt.contentHash,
      mimeType: receipt.mimeType,
      status: receipt.status,
    };
  }
}
