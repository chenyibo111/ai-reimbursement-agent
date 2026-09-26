import { expect, it } from "vitest";

import { loadConfig } from "@/src/server/config";

const productionBase = {
  NODE_ENV: "production",
  RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
  MODEL_PROVIDER: "openai-compatible",
  MODEL_BASE_URL: "https://model.example/v1",
  MODEL_NAME: "chat-model",
  MODEL_PROVIDER_API_KEY: "model-secret",
  SESSION_SECRET: "session-secret",
  FEISHU_APP_ID: "app-id",
  FEISHU_APP_SECRET: "app-secret",
  FEISHU_REDIRECT_URI: "https://example.test/callback",
};

it("parses a fixed-dimension BGE-M3 embedding configuration", () => {
  expect(loadConfig({
    EMBEDDING_PROVIDER: "bge-m3",
    EMBEDDING_BASE_URL: "http://embedding:8080",
  }).embedding).toEqual({
    provider: "bge-m3",
    baseUrl: "http://embedding:8080",
    model: "BAAI/bge-m3",
    dimensions: 1024,
    apiKey: undefined,
    timeoutMs: 20_000,
  });
});

it("rejects fixture embeddings in production", () => {
  expect(() => loadConfig({
    ...productionBase,
    EMBEDDING_PROVIDER: "fixture",
  })).toThrow("fixture embedding provider is not allowed in production");
});

it("rejects an embedding dimension other than the fixed first-version dimension", () => {
  expect(() => loadConfig({
    EMBEDDING_PROVIDER: "bge-m3",
    EMBEDDING_BASE_URL: "http://embedding:8080",
    EMBEDDING_DIMENSIONS: "768",
  })).toThrow("EMBEDDING_DIMENSIONS must be 1024");
});

it("requires a complete OpenAI-compatible embedding configuration", () => {
  expect(() => loadConfig({ EMBEDDING_PROVIDER: "openai-compatible" })).toThrow(
    "EMBEDDING_BASE_URL is required for openai-compatible embedding",
  );
});
