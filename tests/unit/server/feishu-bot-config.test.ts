import { expect, it } from "vitest";

import { loadConfig } from "@/src/server/config";

it("does not require bot-only settings when the Feishu bot is disabled", () => {
  expect(loadConfig({ NODE_ENV: "development" }).feishuBot).toBeUndefined();
});

it("requires the bot open ID when the Feishu bot is enabled", () => {
  expect(() => loadConfig({ FEISHU_BOT_ENABLED: "true" })).toThrow("FEISHU_BOT_OPEN_ID is required when FEISHU_BOT_ENABLED=true");
});

it("requires an employee-accessible public app URL when the Feishu bot is enabled", () => {
  expect(() => loadConfig({ FEISHU_BOT_ENABLED: "true", FEISHU_BOT_OPEN_ID: "ou-bot" })).toThrow(
    "APP_PUBLIC_URL is required when FEISHU_BOT_ENABLED=true",
  );
});

it("only permits long-connection delivery for the enabled bot", () => {
  expect(() => loadConfig({
    FEISHU_BOT_ENABLED: "true",
    FEISHU_BOT_OPEN_ID: "ou-bot",
    APP_PUBLIC_URL: "https://reimbursement.example.test",
    FEISHU_EVENT_DELIVERY: "webhook",
  })).toThrow("FEISHU_EVENT_DELIVERY must be long_connection");
});

it("requires the shared Feishu application credentials for a production bot", () => {
  expect(() => loadConfig({
    NODE_ENV: "production",
    RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
    MODEL_PROVIDER: "openai-compatible",
    MODEL_BASE_URL: "https://models.example.test/v1",
    MODEL_NAME: "model",
    MODEL_PROVIDER_API_KEY: "key",
    SESSION_SECRET: "session-secret",
    FEISHU_BOT_ENABLED: "true",
    FEISHU_BOT_OPEN_ID: "ou-bot",
    APP_PUBLIC_URL: "https://reimbursement.example.test",
  })).toThrow("FEISHU_APP_ID is required in production");
});
