import { expect, it, vi } from "vitest";

import { createLogger } from "@/src/observability/logger";

it("emits a single allowlisted JSON log record without sensitive or unknown fields", () => {
  const write = vi.fn();
  const logger = createLogger("job-worker", { write });

  logger.info("job.claimed", "异步任务已领取", {
    jobId: "job-123",
    jobKind: "RECEIPT_EXTRACTION",
    attempt: 2,
    token: "must-not-appear",
    objectKey: "claims/private/receipt.png",
    arbitrary: "must-not-appear",
  });

  expect(write).toHaveBeenCalledOnce();
  const record = JSON.parse(write.mock.calls[0]![0]) as Record<string, unknown>;
  expect(record).toMatchObject({
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    level: "info",
    service: "job-worker",
    event: "job.claimed",
    message: "异步任务已领取",
    jobId: "job-123",
    jobKind: "RECEIPT_EXTRACTION",
    attempt: 2,
  });
  expect(record).not.toHaveProperty("token");
  expect(record).not.toHaveProperty("objectKey");
  expect(record).not.toHaveProperty("arbitrary");
});
