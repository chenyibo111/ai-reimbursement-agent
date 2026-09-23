import type { ReceiptExtraction } from "@/src/domain/receipt-extraction";

export interface ReceiptExtractionProvider {
  extract(input: { objectKey: string; mimeType: string }): Promise<ReceiptExtraction>;
}
