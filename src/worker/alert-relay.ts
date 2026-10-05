import { createLogger } from "@/src/observability/logger";
import { readAlertRelayConfig } from "@/src/server/alert-relay-config";
import { createAlertRelayServer } from "@/src/worker/alert-relay-runtime";

const logger = createLogger("alert-relay");

async function main() {
  const config = readAlertRelayConfig(process.env);
  const server = createAlertRelayServer({ webhookUrl: config.webhookUrl, logger });
  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    logger.info("worker.stopped", "告警转发服务已停止");
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.listen(config.port, () => {
    logger.info("worker.started", "告警转发服务已启动", { status: config.port });
  });
}

void main().catch(() => {
  logger.error("worker.failed", "告警转发服务启动失败", { failureCode: "worker_failed" });
  process.exitCode = 1;
});
