import { expect, it } from "vitest";

import { loadConfig } from "@/src/server/config";

it("rejects production mode without a receipt extraction provider", () => {
  expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
    "RECEIPT_EXTRACTION_PROVIDER is required in production",
  );
});

it("rejects production mode without a model provider", () => {
  expect(() =>
    loadConfig({
      NODE_ENV: "production",
      RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
    }),
  ).toThrow("MODEL_PROVIDER is required in production");
});

it("rejects production mode without Feishu OAuth credentials", () => {
  expect(() =>
    loadConfig({
      NODE_ENV: "production",
      RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
      MODEL_PROVIDER: "fixture",
      SESSION_SECRET: "session-secret",
    }),
  ).toThrow("FEISHU_APP_ID is required in production");
});

it("rejects fixture extraction in production even when all required settings exist", () => {
  expect(() =>
    loadConfig({
      NODE_ENV: "production",
      RECEIPT_EXTRACTION_PROVIDER: "fixture",
      MODEL_PROVIDER: "fixture",
      SESSION_SECRET: "session-secret",
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_REDIRECT_URI: "https://example.test/callback",
    }),
  ).toThrow("fixture provider is not allowed in production");
});
