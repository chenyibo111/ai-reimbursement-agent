import { createHash } from "node:crypto";

import type { FeishuProcessingResult } from "@/src/application/process-feishu-event";
import type { ClaimedInboundEvent, RecordInboundEvent } from "@/src/infrastructure/prisma/feishu-bot-repository";

type RawFeishuMessageEvent = {
  event_id?: string;
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    message_type?: string;
    chat_id?: string;
    chat_type?: string;
    mentions?: Array<{ id?: { open_id?: string } }>;
  };
};

export type FeishuBotRuntime = {
  onEvent(event: RawFeishuMessageEvent): Promise<void>;
  drainOnce(): Promise<boolean>;
  stop(): Promise<void>;
};

export function createFeishuBotRuntime(deps: {
  repository: {
    recordInbound(input: RecordInboundEvent): Promise<{ id: string; shouldProcess: boolean }>;
    claimNextPending(): Promise<ClaimedInboundEvent | null>;
    markProcessed(id: string): Promise<void>;
    markRetryableFailure(id: string, code: string): Promise<void>;
    markReplyPending(id: string, text: string): Promise<void>;
    markReplyDelivered(id: string): Promise<void>;
    markReplyRetryableFailure(id: string, code: string): Promise<void>;
    markReplyFailed(id: string, code: string): Promise<void>;
  };
  processEvent(input: { eventId: string }): Promise<FeishuProcessingResult>;
  replyText(messageId: string, text: string, uuid: string): Promise<void>;
  onReplyDelivery?: (result: { status: "delivered" | "retrying" | "failed"; attempt: number; failureCode?: string }) => void;
  closeConnection?: () => Promise<void>;
}): FeishuBotRuntime {
  let stopped = false;
  let activeDrain: Promise<boolean> | undefined;

  return {
    async onEvent(event) {
      if (stopped) return;
      const inbound = normalizeInbound(event);
      if (!inbound) return;
      await deps.repository.recordInbound(inbound);
    },
    async drainOnce() {
      if (stopped) return false;
      if (activeDrain) return activeDrain;
      activeDrain = drain(deps, () => stopped);
      try {
        return await activeDrain;
      } finally {
        activeDrain = undefined;
      }
    },
    async stop() {
      stopped = true;
      await activeDrain?.catch(() => undefined);
      await deps.closeConnection?.();
    },
  };
}

async function drain(
  deps: Parameters<typeof createFeishuBotRuntime>[0],
  isStopped: () => boolean,
): Promise<boolean> {
  if (isStopped()) return false;
  const inbound = await deps.repository.claimNextPending();
  if (!inbound) return false;
  if (inbound.status === "REPLY_PROCESSING") {
    if (!inbound.messageId || !inbound.replyText) {
      await deps.repository.markReplyFailed(inbound.id, "INVALID_REPLY");
      deps.onReplyDelivery?.({ status: "failed", attempt: inbound.deliveryAttemptCount, failureCode: "INVALID_REPLY" });
      return true;
    }
    try {
      await deps.replyText(inbound.messageId, inbound.replyText, replyUuid(inbound.messageId));
      await deps.repository.markReplyDelivered(inbound.id);
      deps.onReplyDelivery?.({ status: "delivered", attempt: inbound.deliveryAttemptCount });
    } catch (error) {
      const failureCode = providerFailureCode(error);
      if (inbound.deliveryAttemptCount >= 5) {
        await deps.repository.markReplyFailed(inbound.id, failureCode);
        deps.onReplyDelivery?.({ status: "failed", attempt: inbound.deliveryAttemptCount, failureCode });
      } else {
        await deps.repository.markReplyRetryableFailure(inbound.id, failureCode);
        deps.onReplyDelivery?.({ status: "retrying", attempt: inbound.deliveryAttemptCount, failureCode });
      }
    }
    return true;
  }
  try {
    const result = await deps.processEvent({ eventId: inbound.eventId });
    if (result.kind === "RETRYABLE_FAILURE" && result.retryable) {
      if (inbound.attemptCount >= 3) {
        if (inbound.messageId) await deps.repository.markReplyPending(inbound.id, result.replyText);
        else await deps.repository.markProcessed(inbound.id);
        return true;
      }
      await deps.repository.markRetryableFailure(inbound.id, "RETRYABLE_FAILURE");
      return true;
    }

    const reply = replyFor(result);
    if (reply && inbound.messageId) await deps.repository.markReplyPending(inbound.id, reply);
    else await deps.repository.markProcessed(inbound.id);
    return true;
  } catch {
    if (inbound.attemptCount >= 3 && inbound.messageId) await deps.repository.markReplyPending(inbound.id, "消息暂未处理完成，请稍后重试或在工作台继续。");
    else await deps.repository.markRetryableFailure(inbound.id, "PROCESSING_FAILED");
    return true;
  }
}

function replyUuid(messageId: string): string {
  const hex = createHash("sha256").update(`feishu-reply:${messageId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function providerFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 80);
  return "DELIVERY_UNAVAILABLE";
}

function normalizeInbound(event: RawFeishuMessageEvent): RecordInboundEvent | null {
  const eventId = event.event_id?.trim();
  const messageId = event.message?.message_id?.trim();
  const messageType = event.message?.message_type?.trim();
  const chatId = event.message?.chat_id?.trim();
  const chatType = event.message?.chat_type;
  const senderOpenId = event.sender?.sender_id?.open_id?.trim();
  if (!eventId || !messageId || !messageType || !chatId || !senderOpenId || (chatType !== "p2p" && chatType !== "group")) return null;
  const mentionedOpenIds = [...new Set(event.message?.mentions?.flatMap((mention) => mention.id?.open_id ? [mention.id.open_id] : []) ?? [])];
  return { eventId, messageId, messageType, chatId, senderOpenId, chatType, mentionedOpenIds };
}

function replyFor(result: FeishuProcessingResult): string | null {
  return "replyText" in result ? result.replyText : null;
}
