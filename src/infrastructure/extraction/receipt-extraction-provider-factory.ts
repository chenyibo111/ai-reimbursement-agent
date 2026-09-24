import { FakeReceiptExtractionProvider } from "@/src/infrastructure/extraction/fake-receipt-extraction-provider";
import { PaddleReceiptExtractionProvider } from "@/src/infrastructure/extraction/paddle-receipt-extraction-provider";
import type { ReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider";
import type { ObjectStore } from "@/src/infrastructure/storage/object-store";

type OcrClient = ConstructorParameters<typeof PaddleReceiptExtractionProvider>[0];
type OcrResult = { modelVersion: string; pages: Array<{ text: string; confidence: number }> };

export function createPaddleOcrClient(input: {
  objects: Pick<ObjectStore, "get">;
  endpoint: string;
  fetch?: typeof globalThis.fetch;
}): OcrClient {
  const request = input.fetch ?? globalThis.fetch;
  const endpoint = input.endpoint.replace(/\/$/, "");

  return {
    async extract(receipt) {
      const bytes = await input.objects.get({ key: receipt.objectKey });
      const form = new FormData();
      form.set("file", new Blob([Uint8Array.from(bytes).buffer], { type: receipt.mimeType }), "receipt");
      const response = await request(`${endpoint}/extract`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("OCR service request failed");
      const result: unknown = await response.json();
      if (!isOcrResult(result)) throw new Error("OCR service response is invalid");
      return result;
    },
  };
}

export function createReceiptExtractionProvider(input: {
  provider: string | undefined;
  environment: string | undefined;
  ocr?: OcrClient;
}): ReceiptExtractionProvider {
  if (!input.provider && input.environment !== "production") {
    return new FakeReceiptExtractionProvider();
  }

  if (input.provider === "fixture") {
    if (input.environment === "production") throw new Error("fixture provider is not allowed in production");
    return new FakeReceiptExtractionProvider();
  }

  if (input.provider === "paddleocr") {
    if (!input.ocr) throw new Error("OCR client configuration is required");
    return new PaddleReceiptExtractionProvider(input.ocr);
  }

  throw new Error("unsupported receipt extraction provider");
}

function isOcrResult(value: unknown): value is OcrResult {
  if (!value || typeof value !== "object") return false;
  const result = value as { modelVersion?: unknown; pages?: unknown };
  return typeof result.modelVersion === "string" && Array.isArray(result.pages) && result.pages.every(
    (page) => Boolean(page) && typeof page === "object" && typeof (page as { text?: unknown }).text === "string" && typeof (page as { confidence?: unknown }).confidence === "number",
  );
}
