import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("ships a job runtime dashboard with safe Loki queries for the operational signals", async () => {
  const dashboard = await readFile(new URL("../../observability/grafana/dashboards/job-runtime.json", import.meta.url), "utf8");

  expect(dashboard).toContain('"title": "任务运行总览"');
  expect(dashboard).toContain('service=\\"job-worker\\"');
  expect(dashboard).toContain('event=\\"worker.heartbeat\\"');
  expect(dashboard).toContain('service=\\"ocr\\"');
  expect(dashboard).toContain('service=~\\"web|feishu-worker\\"');
  expect(dashboard).toContain("jobId");
  for (const sensitiveField of ["objectKey", "authorization", "cookie", "token", "open_id", "extractionPayload", "prompt", "embedding"]) {
    expect(dashboard).not.toContain(sensitiveField);
  }
});
