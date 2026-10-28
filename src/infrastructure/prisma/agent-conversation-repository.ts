import { Prisma, type AgentConversation, type AgentMessage, type PrismaClient, type ReimbursementIntake } from "@/generated/prisma/client";
import {
  privateConversationScopeKey,
  type AgentMessageChannel,
  type AgentMessageRole,
  type ReimbursementIntakeStatus,
} from "@/src/domain/agent-conversation";

const MAX_SNAPSHOT_CHARS = 16_000;

export type AppendAgentMessageInput = {
  conversationId: string;
  role: AgentMessageRole;
  channel: AgentMessageChannel;
  channelMessageId?: string | null;
  inReplyToChannelMessageId?: string | null;
  text: string;
  citations?: Prisma.InputJsonValue;
  result?: Prisma.InputJsonValue;
};

export type CreateReimbursementIntakeInput = {
  employeeId: string;
  conversationId: string;
  claimId?: string | null;
  collectedFields?: Prisma.InputJsonValue;
  pendingFields?: string[];
  submissionToken?: string | null;
  submissionPreview?: Prisma.InputJsonValue | null;
};

export type UpdateReimbursementIntakeInput = {
  id: string;
  status?: ReimbursementIntakeStatus;
  claimId?: string | null;
  collectedFields?: Prisma.InputJsonValue;
  pendingFields?: string[];
  submissionToken?: string | null;
  submissionPreview?: Prisma.InputJsonValue | null;
  restartRequestedAt?: Date | null;
  lastUserConfirmationAt?: Date | null;
};

export type RestartReimbursementIntakeInput = {
  employeeId: string;
  conversationId: string;
  intakeId: string;
  requestedAfter: Date;
};

export class AgentConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrCreatePrivate(employeeId: string): Promise<AgentConversation> {
    return this.getOrCreateConversation(employeeId, "PRIVATE", privateConversationScopeKey);
  }

  async getOrCreateGroup(employeeId: string, chatId: string): Promise<AgentConversation> {
    const scopeKey = chatId.trim();
    if (!scopeKey) throw new Error("group chat ID is required");
    return this.getOrCreateConversation(employeeId, "GROUP", scopeKey);
  }

  async recordFeishuDeliveryTarget(input: { conversationId: string; chatId: string }): Promise<void> {
    const chatId = input.chatId.trim();
    if (!chatId) throw new Error("Feishu chat ID is required");
    await this.prisma.agentConversation.update({
      where: { id: input.conversationId },
      data: { latestFeishuChatId: chatId },
    });
  }

  async findNotificationTargetByClaimId(claimId: string): Promise<{ employeeId: string; conversationId: string; chatId: string } | null> {
    const subscribed = await this.prisma.agentClaimNotificationTarget.findUnique({
      where: { claimId },
      select: { employeeId: true, conversationId: true, chatId: true, conversation: { select: { kind: true, employeeId: true } } },
    });
    if (subscribed) {
      if (subscribed.conversation.kind !== "PRIVATE" || subscribed.conversation.employeeId !== subscribed.employeeId) return null;
      const chatId = subscribed.chatId.trim();
      return chatId ? { employeeId: subscribed.employeeId, conversationId: subscribed.conversationId, chatId } : null;
    }
    const intake = await this.prisma.reimbursementIntake.findFirst({
      where: { claimId, conversation: { kind: "PRIVATE", latestFeishuChatId: { not: null } } },
      orderBy: { updatedAt: "desc" },
      select: {
        employeeId: true,
        conversationId: true,
        conversation: { select: { latestFeishuChatId: true } },
      },
    });
    const chatId = intake?.conversation.latestFeishuChatId?.trim();
    return intake && chatId ? { employeeId: intake.employeeId, conversationId: intake.conversationId, chatId } : null;
  }

  async subscribeClaimNotifications(input: { employeeId: string; conversationId: string; chatId: string; claimId: string }): Promise<void> {
    const chatId = input.chatId.trim();
    const claimId = input.claimId.trim();
    if (!chatId || !claimId) throw new Error("private claim notification target is required");
    const conversation = await this.prisma.agentConversation.findFirst({
      where: { id: input.conversationId, employeeId: input.employeeId, kind: "PRIVATE", latestFeishuChatId: chatId },
      select: { id: true },
    });
    if (!conversation) throw new Error("private conversation target is not verified");
    await this.prisma.agentClaimNotificationTarget.upsert({
      where: { claimId },
      create: { claimId, employeeId: input.employeeId, conversationId: input.conversationId, chatId },
      update: { employeeId: input.employeeId, conversationId: input.conversationId, chatId },
    });
  }

  async appendMessage(input: AppendAgentMessageInput): Promise<AgentMessage> {
    return (await this.appendMessageOnce(input)).message;
  }

  async appendUserMessageIfAbsent(input: AppendAgentMessageInput): Promise<{ message: AgentMessage; created: boolean }> {
    if (input.role !== "USER" || !input.channelMessageId?.trim()) throw new Error("channel user message ID is required");
    return this.appendMessageOnce(input);
  }

  private async appendMessageOnce(input: AppendAgentMessageInput): Promise<{ message: AgentMessage; created: boolean }> {
    const channelMessageId = input.channelMessageId?.trim() || null;
    if (channelMessageId) {
      const existing = await this.prisma.agentMessage.findUnique({ where: { channelMessageId } });
      if (existing) return { message: existing, created: false };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (channelMessageId) {
          const existing = await tx.agentMessage.findUnique({ where: { channelMessageId } });
          if (existing) return { message: existing, created: false };
        }

        const conversation = await tx.agentConversation.update({
          where: { id: input.conversationId },
          data: { nextSequence: { increment: 1 }, lastActiveAt: new Date() },
          select: { nextSequence: true },
        });
        const message = await tx.agentMessage.create({
          data: {
            conversationId: input.conversationId,
            sequence: conversation.nextSequence - 1,
            role: input.role,
            channel: input.channel,
            channelMessageId,
            inReplyToChannelMessageId: input.inReplyToChannelMessageId?.trim() || null,
            text: normalizeText(input.text),
            citations: normalizeSnapshot(input.citations),
            result: normalizeSnapshot(input.result),
          },
        });
        return { message, created: true };
      });
    } catch (error) {
      if (!channelMessageId || !isUniqueConstraintError(error)) throw error;
      const duplicate = await this.prisma.agentMessage.findUnique({ where: { channelMessageId } });
      if (!duplicate) throw error;
      return { message: duplicate, created: false };
    }
  }

  async listMessages(input: { conversationId: string; limit?: number }): Promise<AgentMessage[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const newest = await this.prisma.agentMessage.findMany({
      where: { conversationId: input.conversationId },
      orderBy: { sequence: "desc" },
      take: limit,
    });
    return newest.reverse();
  }

  async findAssistantReplyByInboundMessageId(channelMessageId: string): Promise<AgentMessage | null> {
    const inReplyToChannelMessageId = channelMessageId.trim();
    if (!inReplyToChannelMessageId) return null;
    return this.prisma.agentMessage.findFirst({ where: { role: "ASSISTANT", inReplyToChannelMessageId } });
  }

  async getConversationByIdOrThrow(id: string): Promise<AgentConversation> {
    const conversation = await this.prisma.agentConversation.findUnique({ where: { id } });
    if (!conversation) throw new Error("conversation not found");
    return conversation;
  }

  async setSelectedReadClaimId(input: { conversationId: string; claimId: string | null }): Promise<void> {
    await this.prisma.agentConversation.update({
      where: { id: input.conversationId },
      data: { selectedReadClaimId: input.claimId },
    });
  }

  async setSelectedEditClaimId(input: { conversationId: string; claimId: string | null }): Promise<void> {
    await this.prisma.agentConversation.update({
      where: { id: input.conversationId },
      data: { selectedEditClaimId: input.claimId },
    });
  }

  async setPendingAction(input: { conversationId: string; action: import("@/src/application/pending-action").PendingAction | null }): Promise<void> {
    await this.prisma.agentConversation.update({
      where: { id: input.conversationId },
      data: { pendingAction: input.action === null ? Prisma.JsonNull : input.action as Prisma.InputJsonValue },
    });
  }

  async consumePendingAction(input: { conversationId: string; action: import("@/src/application/pending-action").PendingAction }): Promise<boolean> {
    const result = await this.prisma.agentConversation.updateMany({
      where: { id: input.conversationId, pendingAction: { equals: input.action as Prisma.InputJsonValue } },
      data: { pendingAction: Prisma.JsonNull },
    });
    return result.count === 1;
  }

  async setSearchState(input: { conversationId: string; state: import("@/src/application/claim-search").ClaimSearchState | null }): Promise<void> {
    await this.prisma.agentConversation.update({
      where: { id: input.conversationId },
      data: { searchState: input.state === null ? Prisma.JsonNull : input.state as Prisma.InputJsonValue },
    });
  }

  async getCurrentIntake(employeeId: string): Promise<ReimbursementIntake | null> {
    return this.prisma.reimbursementIntake.findFirst({
      where: { employeeId, status: { in: ["COLLECTING", "READY_TO_SUBMIT"] } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async createIntake(input: CreateReimbursementIntakeInput): Promise<ReimbursementIntake> {
    const current = await this.getCurrentIntake(input.employeeId);
    if (current) throw new Error("active intake exists");

    try {
      return await this.prisma.reimbursementIntake.create({
        data: {
          employeeId: input.employeeId,
          conversationId: input.conversationId,
          claimId: input.claimId ?? null,
          collectedFields: normalizeSnapshot(input.collectedFields) ?? {},
          pendingFields: input.pendingFields ?? [],
          submissionToken: input.submissionToken ?? null,
          submissionPreview: input.submissionPreview === null ? Prisma.JsonNull : normalizeSnapshot(input.submissionPreview),
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new Error("active intake exists");
      throw error;
    }
  }

  async updateIntake(input: UpdateReimbursementIntakeInput): Promise<ReimbursementIntake> {
    const data: Prisma.ReimbursementIntakeUpdateInput = {};
    if (input.status !== undefined) data.status = input.status;
    if ("claimId" in input) data.claimId = input.claimId ?? null;
    if (input.collectedFields !== undefined) data.collectedFields = normalizeSnapshot(input.collectedFields) ?? {};
    if (input.pendingFields !== undefined) data.pendingFields = input.pendingFields;
    if ("submissionToken" in input) data.submissionToken = input.submissionToken ?? null;
    if ("submissionPreview" in input) data.submissionPreview = input.submissionPreview === null ? Prisma.JsonNull : normalizeSnapshot(input.submissionPreview);
    if ("restartRequestedAt" in input) data.restartRequestedAt = input.restartRequestedAt ?? null;
    if ("lastUserConfirmationAt" in input) data.lastUserConfirmationAt = input.lastUserConfirmationAt ?? null;
    return this.prisma.reimbursementIntake.update({ where: { id: input.id }, data });
  }

  async restartIntake(input: RestartReimbursementIntakeInput): Promise<ReimbursementIntake> {
    return this.prisma.$transaction(async (tx) => {
      const consumed = await tx.reimbursementIntake.updateMany({
        where: {
          id: input.intakeId,
          employeeId: input.employeeId,
          conversationId: input.conversationId,
          status: { in: ["COLLECTING", "READY_TO_SUBMIT"] },
          restartRequestedAt: { gte: input.requestedAfter },
        },
        data: { status: "ABANDONED", restartRequestedAt: null, submissionToken: null, submissionPreview: Prisma.JsonNull },
      });
      if (consumed.count !== 1) throw new Error("restart request unavailable");
      return tx.reimbursementIntake.create({
        data: { employeeId: input.employeeId, conversationId: input.conversationId, pendingFields: ["purpose"] },
      });
    });
  }

  async compareAndSetSummary(input: { conversationId: string; expectedThroughSequence: number; summary: string; throughSequence: number }): Promise<boolean> {
    if (input.throughSequence < input.expectedThroughSequence) return false;
    const updated = await this.prisma.agentConversation.updateMany({
      where: { id: input.conversationId, summaryThroughSequence: input.expectedThroughSequence },
      data: { summary: normalizeSummary(input.summary), summaryThroughSequence: input.throughSequence, lastActiveAt: new Date() },
    });
    return updated.count === 1;
  }

  private getOrCreateConversation(employeeId: string, kind: "PRIVATE" | "GROUP", scopeKey: string): Promise<AgentConversation> {
    return this.prisma.agentConversation.upsert({
      where: { employeeId_kind_scopeKey: { employeeId, kind, scopeKey } },
      create: { employeeId, kind, scopeKey },
      update: { lastActiveAt: new Date() },
    });
  }
}

function normalizeText(text: string): string {
  const normalized = text.trim();
  if (!normalized) throw new Error("message text is required");
  if (normalized.length > 12_000) throw new Error("message text is too long");
  return normalized;
}

function normalizeSummary(summary: string): string {
  const normalized = summary.trim();
  if (normalized.length > 12_000) throw new Error("conversation summary is too long");
  return normalized;
}

function normalizeSnapshot(value: Prisma.InputJsonValue | undefined): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > MAX_SNAPSHOT_CHARS) throw new Error("message snapshot is too large");
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
