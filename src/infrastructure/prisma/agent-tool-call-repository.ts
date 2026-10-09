import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import type { ReimbursementToolName, ToolCallResultStore } from "../../../services/agent/src/tool-gateway/reimbursement-tools";

/** Agent-owned durable replay store; it never queries reimbursement tables. */
export class PrismaAgentToolCallRepository implements ToolCallResultStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findCompleted(toolCallId: string): Promise<Record<string, unknown> | null> {
    const call = await this.prisma.agentToolCall.findUnique({ where: { toolCallId }, select: { result: true } });
    return call?.result && typeof call.result === "object" && !Array.isArray(call.result) ? call.result as Record<string, unknown> : null;
  }

  async saveCompleted(input: { toolCallId: string; conversationId: string; toolName: ReimbursementToolName; result: Record<string, unknown> }): Promise<void> {
    await this.prisma.agentToolCall.upsert({
      where: { toolCallId: input.toolCallId },
      create: { toolCallId: input.toolCallId, conversationId: input.conversationId, toolName: input.toolName, result: input.result as Prisma.InputJsonValue },
      update: {},
    });
  }
}
