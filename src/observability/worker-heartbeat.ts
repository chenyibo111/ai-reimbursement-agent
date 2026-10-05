import type { Logger } from "@/src/observability/logger";

type WorkerHeartbeatOptions = {
  intervalMs?: number;
  now?: () => number;
  event?: string;
  message?: string;
};

export function createWorkerHeartbeat(logger: Logger, options: WorkerHeartbeatOptions = {}) {
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? Date.now;
  const event = options.event ?? "worker.heartbeat";
  const message = options.message ?? "异步任务 Worker 心跳正常";
  let lastEmittedAt = Number.NEGATIVE_INFINITY;

  return {
    emitIfDue() {
      const currentTime = now();
      if (currentTime - lastEmittedAt < intervalMs) return false;
      lastEmittedAt = currentTime;
      logger.info(event, message, { status: "alive" });
      return true;
    },
  };
}
