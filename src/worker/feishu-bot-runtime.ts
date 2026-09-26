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
  };
  processEvent(input: { eventId: string }): Promise<FeishuProcessingResult>;
  replyText(messageId: string, text: string): Promise<void>;
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
  try {
    const result = await deps.processEvent({ eventId: inbound.eventId });
    if (result.kind === "RETRYABLE_FAILURE" && result.retryable) {
      await deps.repository.markRetryableFailure(inbound.id, "RETRYABLE_FAILURE");
      return true;
    }

    await deps.repository.markProcessed(inbound.id);
    const reply = replyFor(result);
    if (reply && inbound.messageId) {
      try {
        await deps.replyText(inbound.messageId, reply);
      } catch {
        // Business state is already durable. Do not replay the event merely because a reply failed.
      }
    }
    return true;
  } catch {
    await deps.repository.markRetryableFailure(inbound.id, "PROCESSING_FAILED");
    return true;
  }
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
