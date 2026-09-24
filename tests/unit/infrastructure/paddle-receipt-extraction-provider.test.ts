import { expect, it, vi } from "vitest";

import { PaddleReceiptExtractionProvider } from "@/src/infrastructure/extraction/paddle-receipt-extraction-provider";
import { createPaddleOcrClient, createReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider-factory";

it("maps labelled OCR fields without inventing a missing amount", async () => {
  const provider = new PaddleReceiptExtractionProvider({
    extract: async () => ({ modelVersion: "paddle-test", pages: [{ text: "发票号码：12345678\n开票日期：2026年09月20日\n销售方：示例商店", confidence: 0.98 }] }),
  });

  await expect(provider.extract({ objectKey: "claims/a", mimeType: "image/png" })).resolves.toMatchObject({
    modelVersion: "paddle-test",
    invoiceNumber: { value: "12345678", confidence: 0.98 },
    issuedOn: { value: "2026-09-20" },
    totalAmountCents: { value: null, confidence: 0 },
  });
});

it("uses a labelled CNY total as integer cents", async () => {
  const provider = new PaddleReceiptExtractionProvider({
    extract: async () => ({ modelVersion: "paddle-test", pages: [{ text: "价税合计（小写）￥386.00\n发票号码：87654321", confidence: 0.91 }] }),
  });

  await expect(provider.extract({ objectKey: "claims/b", mimeType: "application/pdf" })).resolves.toMatchObject({
    totalAmountCents: { value: 38600, confidence: 0.91 },
  });
});

it("uses the value following a separately recognized parenthesized small-total label", async () => {
  const provider = new PaddleReceiptExtractionProvider({
    extract: async () => ({
      modelVersion: "paddle-test",
      pages: [{ text: "价税合计（大写）\n壹佰零贰圆肆角贰分\n(小写) ¥102.42", confidence: 0.97 }],
    }),
  });

  await expect(provider.extract({ objectKey: "claims/c", mimeType: "application/pdf" })).resolves.toMatchObject({
    totalAmountCents: { value: 10242, confidence: 0.97 },
  });
});

it("rejects the fixture provider in production", () => {
  expect(() => createReceiptExtractionProvider({ provider: "fixture", environment: "production" })).toThrow(
    "fixture provider is not allowed",
  );
});

it("uses the fixture provider by default outside production", async () => {
  const provider = createReceiptExtractionProvider({ provider: undefined, environment: "test" });

  await expect(provider.extract({ objectKey: "claims/receipt", mimeType: "image/png" })).resolves.toMatchObject({
    modelVersion: "fixture-v1",
  });
});

it("sends the stored receipt bytes to the private OCR service", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const client = createPaddleOcrClient({
    objects: { get: async () => new Uint8Array([1, 2, 3]) },
    endpoint: "http://127.0.0.1:8000",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ modelVersion: "paddle-test", pages: [] }), { status: 200 });
    },
  });

  await expect(client.extract({ objectKey: "claims/receipt.png", mimeType: "image/png" })).resolves.toEqual({
    modelVersion: "paddle-test",
    pages: [],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("http://127.0.0.1:8000/extract");
  expect(calls[0]?.init?.method).toBe("POST");
  const file = (calls[0]?.init?.body as FormData).get("file") as File;
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(file.type).toBe("image/png");
  expect(timeout).toHaveBeenCalledWith(120_000);
  timeout.mockRestore();
});
