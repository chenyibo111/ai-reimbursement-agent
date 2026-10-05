import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("defines bounded failure alerts and documents protected observability operations", async () => {
  const [rules, operations, architecture, traceContext] = await Promise.all([
    readFile(new URL("../../observability/loki-rules.yml", import.meta.url), "utf8"),
    readFile(new URL("../../docs/operations.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/architecture.md", import.meta.url), "utf8"),
    readFile(new URL("../../src/observability/trace-context.ts", import.meta.url), "utf8"),
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
  expect(architecture).toContain("OpenTelemetry");
  expect(traceContext).toContain("traceId");
  expect(traceContext).toContain("spanId");
});
