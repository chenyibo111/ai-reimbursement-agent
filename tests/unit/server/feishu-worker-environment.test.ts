import { expect, it } from "vitest";

import { loadConfig, validateFeishuWorkerEnvironment } from "@/src/server/config";

const productionBase = {
  NODE_ENV: "production",
  RECEIPT_EXTRACTION_PROVIDER: "paddleocr",
  MODEL_PROVIDER: "openai-compatible",
  MODEL_BASE_URL: "https://models.example.test/v1",
  MODEL_NAME: "model",
  MODEL_PROVIDER_API_KEY: "model-key",
  SESSION_SECRET: "session-secret",
  FEISHU_APP_ID: "cli_app",
  FEISHU_APP_SECRET: "app-secret",
  FEISHU_REDIRECT_URI: "https://reimbursement.example.test/api/auth/feishu/callback",
  FEISHU_BOT_ENABLED: "true",
  FEISHU_BOT_OPEN_ID: "ou-bot",
  FEISHU_EVENT_DELIVERY: "long_connection",
  APP_PUBLIC_URL: "https://reimbursement.example.test",
  DATABASE_URL: "postgresql://user:password@db:5432/reimbursement",
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "reimbursement-private",
  S3_ACCESS_KEY_ID: "access",
  S3_SECRET_ACCESS_KEY: "secret",
  CLAMAV_HOST: "clamav",
  OCR_SERVICE_URL: "http://ocr:8000",
};

it("requires explicit bot enablement before a Worker can start", () => {
  expect(() => validateFeishuWorkerEnvironment({ ...productionBase, FEISHU_BOT_ENABLED: "false" })).toThrow(
    "FEISHU_BOT_ENABLED=true is required to start the Feishu worker",
  );
});

it("requires a public HTTPS workspace URL in production", () => {
  expect(() => validateFeishuWorkerEnvironment({ ...productionBase, APP_PUBLIC_URL: "http://localhost:3000" })).toThrow(
    "APP_PUBLIC_URL must use HTTPS in production",
  );
});

it("requires shared data and receipt-processing services for the Worker", () => {
  expect(() => validateFeishuWorkerEnvironment({ ...productionBase, S3_ENDPOINT: undefined })).toThrow(
    "S3_ENDPOINT is required to start the Feishu worker",
  );
  expect(() => validateFeishuWorkerEnvironment({ ...productionBase, OCR_SERVICE_URL: undefined })).toThrow(
    "OCR_SERVICE_URL is required to start the Feishu worker",
  );
});

it("keeps the Web configuration usable when the bot is disabled", () => {
  expect(loadConfig({ NODE_ENV: "development" }).feishuBot).toBeUndefined();
});
