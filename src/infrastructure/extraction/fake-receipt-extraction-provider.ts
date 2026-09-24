import type { ReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider";

export class FakeReceiptExtractionProvider implements ReceiptExtractionProvider {
  async extract(): Promise<Awaited<ReturnType<ReceiptExtractionProvider["extract"]>>> {
    return {
      modelVersion: "fixture-v1",
      receiptType: "VAT_INVOICE",
      invoiceNumber: { value: "FIXTURE-INVOICE", confidence: 0.99, source: "EXTRACTED" },
      issuedOn: { value: "2026-09-20", confidence: 0.99, source: "EXTRACTED" },
      totalAmountCents: { value: 38600, confidence: 0.99, source: "EXTRACTED" },
      taxAmountCents: { value: 2100, confidence: 0.99, source: "EXTRACTED" },
      sellerName: { value: "Fixture Store", confidence: 0.99, source: "EXTRACTED" },
    };
  }
}
