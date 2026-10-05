import { expect, it } from "vitest";

import { readAlertRelayConfig } from "@/src/server/alert-relay-config";

it("rejects a missing alert webhook without echoing a credential", () => {
  expect(() => readAlertRelayConfig({})).toThrow("FEISHU_ALERT_WEBHOOK_URL is required");
});

it("accepts only an HTTPS Feishu group bot webhook", () => {
  expect(() => readAlertRelayConfig({
    FEISHU_ALERT_WEBHOOK_URL: "http://open.feishu.cn/open-apis/bot/v2/hook/unsafe",
  })).toThrow("FEISHU_ALERT_WEBHOOK_URL must be an HTTPS Feishu group bot webhook");

  expect(() => readAlertRelayConfig({
    FEISHU_ALERT_WEBHOOK_URL: "https://example.test/open-apis/bot/v2/hook/unsafe",
  })).toThrow("FEISHU_ALERT_WEBHOOK_URL must be an HTTPS Feishu group bot webhook");

  expect(() => readAlertRelayConfig({
    FEISHU_ALERT_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/",
  })).toThrow("FEISHU_ALERT_WEBHOOK_URL must be an HTTPS Feishu group bot webhook");

  expect(() => readAlertRelayConfig({
    FEISHU_ALERT_WEBHOOK_URL: "https://user:password@open.feishu.cn/open-apis/bot/v2/hook/token",
  })).toThrow("FEISHU_ALERT_WEBHOOK_URL must be an HTTPS Feishu group bot webhook");

  expect(() => readAlertRelayConfig({
    FEISHU_ALERT_WEBHOOK_URL: "https://open.feishu.cn:8443/open-apis/bot/v2/hook/token",
  })).toThrow("FEISHU_ALERT_WEBHOOK_URL must be an HTTPS Feishu group bot webhook");

  expect(readAlertRelayConfig({
    FEISHU_ALERT_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
  })).toEqual({
    webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    port: 8082,
  });
});
