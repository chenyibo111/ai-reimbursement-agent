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
};

function respond(response: ServerResponse, status: number, body = ""): void {
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

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      respond(response, 200, "ok");
      return;
    }
    if (request.method !== "POST" || request.url !== "/alertmanager") {
      respond(response, 405, "method_not_allowed");
      return;
    }

    const payload = await readJsonBody(request);
    const batch = payload ? parseAlertmanagerWebhook(payload) : null;
    if (!batch) {
      respond(response, 400, "invalid_alertmanager_payload");
      return;
    }

    const startedAt = now().getTime();
    try {
      const providerResponse = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(renderFeishuAlertCard(batch)),
      });
      const durationMs = now().getTime() - startedAt;
      if (!providerResponse.ok) {
        logger.warn("alert.delivery.failed", "飞书告警投递失败", {
          count: batch.alerts.length,
          status: providerResponse.status,
          durationMs,
          failureCode: "feishu_webhook_rejected",
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
    } catch {
      logger.warn("alert.delivery.failed", "飞书告警投递失败", {
        count: batch.alerts.length,
        durationMs: now().getTime() - startedAt,
        failureCode: "feishu_webhook_unavailable",
      });
      respond(response, 502, "feishu_delivery_failed");
    }
  });
}
