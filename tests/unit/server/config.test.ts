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

it("requires complete OpenAI-compatible model configuration in production", () => {
  expect(() =>
    loadConfig({
      NODE_ENV: "production",
      RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
      MODEL_PROVIDER: "openai-compatible",
      SESSION_SECRET: "session-secret",
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_REDIRECT_URI: "https://example.test/callback",
    }),
  ).toThrow("MODEL_BASE_URL is required for openai-compatible");
});

it("rejects fixture model provider in production", () => {
  expect(() =>
    loadConfig({
      NODE_ENV: "production",
      RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
      MODEL_PROVIDER: "fixture",
      SESSION_SECRET: "session-secret",
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_REDIRECT_URI: "https://example.test/callback",
    }),
  ).toThrow("fixture model provider is not allowed in production");
});

it("configures policy document access without the retired Next OAuth callback", () => {
  const config = loadConfig({ NODE_ENV: "production", RECEIPT_EXTRACTION_PROVIDER: "paddleocr", MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "https://models.example.test/v1", MODEL_NAME: "model", MODEL_PROVIDER_API_KEY: "key", FEISHU_APP_ID: "cli_app", FEISHU_APP_SECRET: "secret" });
  expect(config.feishuApp).toEqual({ appId: "cli_app", appSecret: "secret" });
});
