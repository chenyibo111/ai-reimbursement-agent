import { expect, it, vi } from "vitest";

import { createWorkerHeartbeat } from "@/src/observability/worker-heartbeat";

it("emits one stable heartbeat per interval while the worker is idle", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  let now = 0;
  const heartbeat = createWorkerHeartbeat(logger, { intervalMs: 60_000, now: () => now });

  heartbeat.emitIfDue();
  heartbeat.emitIfDue();
  now = 59_999;
  heartbeat.emitIfDue();
  now = 60_000;
  heartbeat.emitIfDue();

  expect(logger.info).toHaveBeenCalledTimes(2);
  expect(logger.info).toHaveBeenNthCalledWith(1, "worker.heartbeat", "异步任务 Worker 心跳正常", { status: "alive" });
  expect(logger.info).toHaveBeenNthCalledWith(2, "worker.heartbeat", "异步任务 Worker 心跳正常", { status: "alive" });
});
