import type { ConversationTurnResult } from "@/src/application/run-conversation-turn";
import type { FeishuInboundMessage, FeishuMessageContent } from "@/src/domain/feishu-bot";
import type { FeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";

export type FeishuProcessingResult =
  | { kind: "IGNORED" }
  | { kind: "LOGIN_REQUIRED"; replyText: string }
  | { kind: "AGENT_REPLIED"; claimId: string | null; replyText: string }
  | { kind: "RETRYABLE_FAILURE"; claimId?: string; retryable: boolean; replyText: string };

type StoredInboundEvent = {
  eventId: string;
  messageId: string | null;
  messageType: string;
  chatId: string;
  senderOpenId: string;
  chatType: string;
  mentionedOpenIds: string[];
};

type Conversation = { id: string };

export type ProcessFeishuEventDeps = {
  botOpenId: string;
  publicAppUrl: string;
  events: {
    findInboundByEventId(eventId: string): Promise<StoredInboundEvent | null>;
    findEmployeeByOpenId(openId: string): Promise<{ id: string } | null>;
  };
  conversations: {
    getOrCreatePrivate(employeeId: string): Promise<Conversation>;
    getOrCreateGroup(employeeId: string, chatId: string): Promise<Conversation>;
  };
  client: FeishuBotClient;
  runConversationTurn(input: {
    actorId: string;
    conversationId: string;
    channel: "FEISHU";
    channelMessageId: string;
    message: string;
    attachment?: { filename: string; mimeType: string; bytes: Uint8Array };
  }): Promise<ConversationTurnResult>;
};

export async function processFeishuEvent(
  input: { eventId: string },
  deps: ProcessFeishuEventDeps,
): Promise<FeishuProcessingResult> {
  const event = await deps.events.findInboundByEventId(input.eventId);
  if (!event?.messageId) return failed(false, "消息无法处理，请稍后重新发送。");

  const fetchedMessage = await deps.client.getMessage(event.messageId);
  assertEventMatchesMessage(event, fetchedMessage);
  const message: FeishuInboundMessage = {
    ...fetchedMessage,
    chatType: event.chatType === "group" ? "group" : "p2p",
    mentions: event.mentionedOpenIds,
  };
  if (message.chatType === "group" && !message.mentions.includes(deps.botOpenId)) return { kind: "IGNORED" };

  const employee = await deps.events.findEmployeeByOpenId(message.senderOpenId);
  if (!employee) {
    return {
      kind: "LOGIN_REQUIRED",
      replyText: `请先登录并绑定飞书账号：${deps.publicAppUrl}/api/auth/feishu/login`,
    };
  }

  const conversation = message.chatType === "group"
    ? await deps.conversations.getOrCreateGroup(employee.id, message.chatId)
    : await deps.conversations.getOrCreatePrivate(employee.id);
  const attachment = await downloadFirstAttachment(message, deps.client);
  if (attachment instanceof Error) return failed(true, "附件暂未下载完成，请稍后重试或在工作台上传。");

  try {
    const result = await deps.runConversationTurn({
      actorId: employee.id,
      conversationId: conversation.id,
      channel: "FEISHU",
      channelMessageId: message.messageId,
      message: normalizeMessage(message.text, Boolean(attachment)),
      ...(attachment ? { attachment } : {}),
    });
    return {
      kind: "AGENT_REPLIED",
      claimId: result.intake?.claimId ?? null,
      replyText: formatReply(result, deps.publicAppUrl),
    };
  } catch (error) {
    if (isAttachmentValidationError(error)) {
      return failed(false, "附件仅支持 JPG、PNG 或 PDF，大小不超过 20MB，且文件内容需与格式一致。");
    }
    if (isNonRetryableConversationError(error)) {
      return failed(false, "当前报销办理状态无法执行此操作，请按提示补充信息后重试。");
    }
    return failed(true, "消息暂未处理完成，请稍后重试或在工作台继续。");
  }
}

async function downloadFirstAttachment(message: FeishuInboundMessage, client: FeishuBotClient): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | Error | null> {
  const attachment = message.attachments[0];
  if (!attachment) return null;
  try {
    const downloaded = await client.downloadResource(message.messageId, attachment.fileKey, attachment.resourceType);
    return {
      filename: safeFilename(attachment.filename ?? downloaded.filename),
      mimeType: downloaded.mimeType,
      bytes: downloaded.bytes,
    };
  } catch {
    return new Error("attachment download failed");
  }
}

function normalizeMessage(text: string, hasAttachment: boolean): string {
  const normalized = text.trim();
  if (normalized === "新建报销") return "开始报销";
  if (normalized) return normalized;
  return hasAttachment ? "上传票据" : "你好";
}

function formatReply(result: ConversationTurnResult, publicAppUrl: string): string {
  const reply = result.reply.trim().slice(0, 1_000) || "我已收到你的消息。";
  const citations = result.citations.slice(0, 3).map((citation) => {
    const section = citation.headingPath.filter(Boolean).join(" > ");
    const excerpt = citation.excerpt.trim().replace(/\s+/g, " ").slice(0, 280);
    return `政策依据：${citation.title}${section ? `（${section}）` : ""}${excerpt ? `\n证据摘录：${excerpt}` : ""}`;
  }).join("\n");
  const workspace = result.intake?.claimId
    ? `请在工作台确认或补充信息：${claimUrl(publicAppUrl, result.intake.claimId)}`
    : `可在报销工作台继续办理：${publicAppUrl}/claims`;
  return [reply, citations, workspace].filter(Boolean).join("\n\n");
}

function failed(retryable: boolean, replyText: string): FeishuProcessingResult {
  return {
    kind: "RETRYABLE_FAILURE",
    retryable,
    replyText,
  };
}

function isAttachmentValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return ["unsupported or oversized file", "file signature does not match declared type", "invalid PDF", "PDF exceeds 20 pages", "unsafe file"].includes(message);
}

function isNonRetryableConversationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return ["no ready Intake", "message is invalid", "active intake exists"].includes(message);
}

function safeFilename(value: string): string {
  return value.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "receipt";
}

function claimUrl(publicAppUrl: string, claimId: string): string {
  return `${publicAppUrl}/claims/${encodeURIComponent(claimId)}`;
}

function assertEventMatchesMessage(event: StoredInboundEvent, message: FeishuMessageContent) {
  if (event.messageId !== message.messageId || event.chatId !== message.chatId || event.senderOpenId !== message.senderOpenId) {
    throw new Error("feishu message metadata mismatch");
  }
}
