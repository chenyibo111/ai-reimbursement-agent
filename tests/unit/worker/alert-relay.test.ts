import { once } from "node:events";

import { expect, it, vi } from "vitest";

import { createLogger } from "@/src/observability/logger";
import { createAlertRelayServer } from "@/src/worker/alert-relay-runtime";

const webhookUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/test-token";

const alertPayload = {
  status: "firing",
  alerts: [{
    status: "firing",
    labels: { alertname: "JobWorkerHeartbeatMissing", severity: "critical", service: "job-worker", claimId: "claim-secret" },
    annotations: { summary: "异步任务 Worker 已超过 5 分钟没有心跳", raw: "must-not-leak" },
    startsAt: "2026-10-06T00:00:00.000Z",
  }],
};

async function request(server: ReturnType<typeof createAlertRelayServer>, path: string, init?: RequestInit) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address is unavailable");

  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    server.close();
    await once(server, "close");
  }
}

it("accepts Alertmanager payloads and delivers a safe Feishu card", async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
  const records: string[] = [];
  const server = createAlertRelayServer({
    webhookUrl,
    fetchImpl,
    logger: createLogger("alert-relay", { write: (line) => records.push(line) }),
    now: () => new Date("2026-10-06T00:00:01.000Z"),
  });

  const response = await request(server, "/alertmanager", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alertPayload),
  });

  expect(response.status).toBe(200);
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [, init] = fetchImpl.mock.calls[0]!;
  expect(JSON.stringify(init)).toContain("JobWorkerHeartbeatMissing");
  expect(JSON.stringify(init)).not.toContain("claim-secret");
  expect(JSON.stringify(init)).not.toContain("must-not-leak");
  expect(records.join("\n")).not.toContain("test-token");
});

it("provides health checks and rejects invalid requests", async () => {
  const server = createAlertRelayServer({ webhookUrl, fetchImpl: fetch });

  await expect(request(server, "/health")).resolves.toMatchObject({ status: 200 });
  await expect(request(server, "/alertmanager")).resolves.toMatchObject({ status: 405 });
  await expect(request(server, "/alertmanager", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "firing", alerts: [] }),
  })).resolves.toMatchObject({ status: 400 });
});

it("returns a retryable status when Feishu rejects or times out", async () => {
  const rejected = createAlertRelayServer({
    webhookUrl,
    fetchImpl: async () => new Response(null, { status: 500 }),
    logger: createLogger("alert-relay", { write: () => undefined }),
  });
  const timedOut = createAlertRelayServer({
    webhookUrl,
    fetchImpl: async () => { throw new Error("timeout"); },
    logger: createLogger("alert-relay", { write: () => undefined }),
  });

  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alertPayload),
  };
  await expect(request(rejected, "/alertmanager", init)).resolves.toMatchObject({ status: 502 });
  await expect(request(timedOut, "/alertmanager", init)).resolves.toMatchObject({ status: 502 });
});
