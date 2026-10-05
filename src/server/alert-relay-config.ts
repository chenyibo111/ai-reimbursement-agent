export type AlertRelayConfig = {
  webhookUrl: string;
  port: number;
};

const invalidWebhookMessage = "FEISHU_ALERT_WEBHOOK_URL must be an HTTPS Feishu group bot webhook";

export function readAlertRelayConfig(env: Record<string, string | undefined>): AlertRelayConfig {
  const webhookUrl = env.FEISHU_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error("FEISHU_ALERT_WEBHOOK_URL is required");

  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error(invalidWebhookMessage);
  }

  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "open.feishu.cn"
    || Boolean(parsed.port)
    || Boolean(parsed.username)
    || Boolean(parsed.password)
    || !parsed.pathname.startsWith("/open-apis/bot/v2/hook/")
    || !parsed.pathname.slice("/open-apis/bot/v2/hook/".length)
    || parsed.pathname.slice("/open-apis/bot/v2/hook/".length).includes("/")
  ) {
    throw new Error(invalidWebhookMessage);
  }

  return { webhookUrl, port: 8082 };
}
