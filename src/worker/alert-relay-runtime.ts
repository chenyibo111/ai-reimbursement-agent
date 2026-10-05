import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { parseAlertmanagerWebhook, renderFeishuAlertCard } from "@/src/observability/alert-relay";
import { createLogger, type Logger } from "@/src/observability/logger";

const maxBodyBytes = 256 * 1024;

type FetchImplementation = typeof fetch;

export type AlertRelayServerOptions = {
  webhookUrl: string;
  fetchImpl?: FetchImplementation;
  logger?: Logger;
  now?: () => Date;
  deliveryTimeoutMs?: number;
};

function respond(response: ServerResponse, status: number, body = ""): void {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body ? JSON.stringify({ status: body }) : undefined);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let received = 0;

  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += value.length;
    if (received > maxBodyBytes) return null;
    chunks.push(value);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export function createAlertRelayServer(options: AlertRelayServerOptions): Server {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? createLogger("alert-relay");
  const now = options.now ?? (() => new Date());
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 5_000;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") {
      respond(response, 200, "ok");
      return;
    }
    if (request.method !== "POST" || request.url !== "/alertmanager") {
      respond(response, 405, "method_not_allowed");
      return;
    }

    let payload: unknown | null;
    try {
      payload = await readJsonBody(request);
    } catch {
      respond(response, 400, "invalid_alertmanager_payload");
      return;
    }
    const batch = payload ? parseAlertmanagerWebhook(payload) : null;
    if (!batch) {
      respond(response, 400, "invalid_alertmanager_payload");
      return;
    }

    const startedAt = now().getTime();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
    try {
      const providerResponse = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(renderFeishuAlertCard(batch)),
        signal: controller.signal,
      });
      const durationMs = now().getTime() - startedAt;
      const providerBody = await providerResponse.json().catch(() => null) as { code?: unknown } | null;
      if (!providerResponse.ok || providerBody?.code !== 0) {
        logger.warn("alert.delivery.failed", "飞书告警投递失败", {
          count: batch.alerts.length,
          status: providerResponse.status,
          durationMs,
          failureCode: providerResponse.ok ? "feishu_webhook_invalid_response" : "feishu_webhook_rejected",
        });
        respond(response, 502, "feishu_delivery_failed");
        return;
      }

      logger.info("alert.delivery.completed", "飞书告警已投递", {
        count: batch.alerts.length,
        status: providerResponse.status,
        durationMs,
      });
      respond(response, 200, "delivered");
    } catch (error) {
      logger.warn("alert.delivery.failed", "飞书告警投递失败", {
        count: batch.alerts.length,
        durationMs: now().getTime() - startedAt,
        failureCode: error instanceof DOMException && error.name === "AbortError" ? "feishu_webhook_timeout" : "feishu_webhook_unavailable",
      });
      respond(response, 502, "feishu_delivery_failed");
    } finally {
      clearTimeout(timeout);
    }
  };

  return createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      respond(response, 500, "alert_relay_failed");
    });
  });
}
