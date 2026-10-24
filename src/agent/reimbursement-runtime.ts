import { ReimbursementApiClient, ReimbursementApiHttpError } from "../../services/agent/src/adapters/reimbursement-api-client";
import { createConversationReimbursementTools } from "../../services/agent/src/tool-gateway/conversation-reimbursement";
import { ReimbursementToolGateway } from "../../services/agent/src/tool-gateway/reimbursement-tools";
import { PrismaAgentToolCallRepository } from "@/src/infrastructure/prisma/agent-tool-call-repository";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLogger, type LogService } from "@/src/observability/logger";

export function createAgentReimbursementRuntime(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, service: Extract<LogService, "web" | "feishu-worker"> = "web") {
  const logger = createLogger(service);
  const readConfig = (name: string) => required(env, name, logger);
  const api = new ReimbursementApiClient({
    baseUrl: readConfig("REIMBURSEMENT_API_URL"),
    serviceKey: readConfig("REIMBURSEMENT_AGENT_SERVICE_KEY"),
    signingSecret: readConfig("REIMBURSEMENT_AUTH_HS256_SECRET"),
    fetcher,
  });
  const gateway = new ReimbursementToolGateway(api, new PrismaAgentToolCallRepository(prisma), (error, call) => {
    const status = error instanceof ReimbursementApiHttpError ? error.status : undefined;
    const event = status === 401 || status === 403 ? "tool.unauthorized" : status && status < 500 ? "tool.rejected" : "tool.unavailable";
    logger.error(event, "Agent 报销工具调用失败", { failureCode: event, status, claimId: typeof call.arguments.claimId === "string" ? call.arguments.claimId : undefined });
  });
  return createConversationReimbursementTools(gateway, fetcher, env.REIMBURSEMENT_AGENT_STORAGE_ENDPOINT);
}

function required(env: NodeJS.ProcessEnv, name: string, logger: ReturnType<typeof createLogger>): string {
  const value = env[name]?.trim();
  if (!value) {
    logger.error("tool.configuration_missing", "Agent 报销工具缺少必需配置", { failureCode: "tool.configuration_missing" });
    throw new Error(`${name} is required`);
  }
  return value;
}
