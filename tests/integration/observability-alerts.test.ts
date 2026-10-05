import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("defines bounded failure alerts and documents protected observability operations", async () => {
  const [rules, operations, architecture, traceContext, environment] = await Promise.all([
    readFile(new URL("../../observability/loki-rules.yml", import.meta.url), "utf8"),
    readFile(new URL("../../docs/operations.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/architecture.md", import.meta.url), "utf8"),
    readFile(new URL("../../src/observability/trace-context.ts", import.meta.url), "utf8"),
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  ]);

  for (const alert of ["JobWorkerHeartbeatMissing", "ReceiptExtractionQueueDelayed", "OcrFailureRateHigh", "ReviewQueueGrowing", "ObservabilityPipelineFailed"]) {
    expect(rules).toContain(`alert: ${alert}`);
  }
  expect(rules).toContain("for: 5m");
  expect(rules).toContain("[15m]");
  expect(rules).toContain(">= 10");
  expect(rules).toContain("[30m]");
  expect(operations).toContain("30 天");
  expect(operations).toContain("不得暴露");
  expect(operations).toContain("FEISHU_ALERT_WEBHOOK_URL");
  expect(operations).toContain("专用告警群");
  expect(operations).toContain("docker compose --profile observability up -d --build");
  expect(operations).toContain("固定域名");
  expect(architecture).toContain("OpenTelemetry");
  expect(architecture).toContain("Alertmanager");
  expect(architecture).toContain("alert-relay");
  expect(traceContext).toContain("traceId");
  expect(traceContext).toContain("spanId");
  expect(environment).toContain('FEISHU_ALERT_WEBHOOK_URL=""');
});
