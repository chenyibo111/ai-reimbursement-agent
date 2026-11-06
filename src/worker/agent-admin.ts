import { createServer } from "node:http";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createLogger } from "@/src/observability/logger";
import { createAgentAdminHandler } from "@/src/server/agent-admin-http";

const logger = createLogger("agent-admin");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const serviceKey = process.env.AGENT_ADMIN_SERVICE_KEY;
  const port = Number(process.env.PORT ?? 8083);
  if (!databaseUrl || !serviceKey || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("agent administration is not configured");
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  const server = createServer(createAgentAdminHandler({ prisma, serviceKey }));
  server.listen(port, "0.0.0.0", () => logger.info("worker.started", "政策来源管理服务已启动", { status: port }));
  const stop = () => server.close(() => { void prisma.$disconnect(); });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch(() => {
  logger.error("worker.failed", "政策来源管理服务启动失败", { failureCode: "agent_admin_failed" });
  process.exitCode = 1;
});
