import type { AgentTurnResult } from "@/src/application/run-agent-turn";
import type { ExtractReceiptResult } from "@/src/application/extract-receipt";
import type { Claim } from "@/src/domain/claim";
import { parseFeishuBotCommand, type FeishuInboundMessage } from "@/src/domain/feishu-bot";
import type { Receipt, ReceiptStatus } from "@/src/domain/receipt";
import type { UploadReceiptInput } from "@/src/application/upload-receipt";
import type { FeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";

export type FeishuProcessingResult =
  | { kind: "IGNORED" }
  | { kind: "LOGIN_REQUIRED"; replyText: string }
  | { kind: "CLAIM_LINKED"; claimId: string | null; replyText: string }
  | { kind: "AGENT_REPLIED"; claimId: string; replyText: string }
  | { kind: "ATTACHMENT_QUEUED"; claimId: string; receiptId: string; receiptStatus: ReceiptStatus; filename: string; replyText: string }
  | { kind: "RETRYABLE_FAILURE"; claimId?: string; retryable: boolean; replyText: string };

type StoredInboundEvent = {
  eventId: string;
  messageId: string | null;
  messageType: string;
  chatId: string;
  senderOpenId: string;
};

export type ProcessFeishuEventDeps = {
  botOpenId: string;
  publicAppUrl: string;
  events: {
    findInboundByEventId(eventId: string): Promise<StoredInboundEvent | null>;
    findEmployeeByOpenId(openId: string): Promise<{ id: string } | null>;
    getConversation(employeeId: string, chatId: string): Promise<{ claimId: string } | null>;
    setConversation(employeeId: string, chatId: string, claimId: string): Promise<void>;
  };
  client: FeishuBotClient;
  createClaimDraft(input: { actorId: string; purpose?: string }): Promise<Claim>;
  runAgentTurn(input: { actorId: string; claimId: string; message: string }): Promise<AgentTurnResult>;
  uploadReceipt(input: UploadReceiptInput): Promise<Receipt>;
  extractReceipt(input: { actorId: string; claimId: string; receiptId: string }): Promise<ExtractReceiptResult>;
};

export async function processFeishuEvent(
  input: { eventId: string },
  deps: ProcessFeishuEventDeps,
): Promise<FeishuProcessingResult> {
  const event = await deps.events.findInboundByEventId(input.eventId);
  if (!event?.messageId) return { kind: "RETRYABLE_FAILURE", retryable: false, replyText: "消息无法处理，请稍后重新发送。" };

  const message = await deps.client.getMessage(event.messageId);
  assertEventMatchesMessage(event, message);
  if (message.chatType === "group" && !message.mentions.includes(deps.botOpenId)) return { kind: "IGNORED" };

  const employee = await deps.events.findEmployeeByOpenId(message.senderOpenId);
  if (!employee) {
    return {
      kind: "LOGIN_REQUIRED",
      replyText: `请先登录并绑定飞书账号：${deps.publicAppUrl}/api/auth/feishu/login`,
    };
  }

  const command = parseFeishuBotCommand(message.text);
  if (command === "NEW_CLAIM") {
    const claim = await createAndLink(employee.id, message.chatId, deps);
    return linked(claim.id, deps.publicAppUrl, "已新建报销草稿");
  }

  const conversation = await deps.events.getConversation(employee.id, message.chatId);
  if (command === "VIEW_CURRENT_CLAIM") {
    if (!conversation) return { kind: "CLAIM_LINKED", claimId: null, replyText: "当前会话还没有报销草稿。请发送票据或输入“新建报销”。" };
    return linked(conversation.claimId, deps.publicAppUrl, "当前报销草稿");
  }

  const claim = conversation
    ? { id: conversation.claimId }
    : await createAndLink(employee.id, message.chatId, deps);
  if (message.attachments.length > 0) {
    return processAttachment({ employeeId: employee.id, claimId: claim.id, message, deps });
  }
  if (!message.text.trim()) return linked(claim.id, deps.publicAppUrl, "已关联报销草稿");

  const agent = await deps.runAgentTurn({ actorId: employee.id, claimId: claim.id, message: message.text });
  return {
    kind: "AGENT_REPLIED",
    claimId: claim.id,
    replyText: `${safeReply(agent)}\n\n请在工作台确认或补充信息：${claimUrl(deps.publicAppUrl, claim.id)}`,
  };
}

async function processAttachment(input: { employeeId: string; claimId: string; message: FeishuInboundMessage; deps: ProcessFeishuEventDeps }): Promise<FeishuProcessingResult> {
  const attachment = input.message.attachments[0];
  if (!attachment) return { kind: "RETRYABLE_FAILURE", claimId: input.claimId, retryable: false, replyText: `未找到可处理的附件，请在工作台上传：${claimUrl(input.deps.publicAppUrl, input.claimId)}` };
  try {
    const downloaded = await input.deps.client.downloadResource(input.message.messageId, attachment.fileKey, attachment.resourceType);
    validateDownloadedAttachment(downloaded.mimeType, downloaded.bytes);
    const filename = safeFilename(attachment.filename ?? downloaded.filename);
    const receipt = await input.deps.uploadReceipt({
      actorId: input.employeeId,
      claimId: input.claimId,
      filename,
      mimeType: downloaded.mimeType,
      bytes: downloaded.bytes,
    });
    await input.deps.extractReceipt({ actorId: input.employeeId, claimId: input.claimId, receiptId: receipt.id });
    return {
      kind: "ATTACHMENT_QUEUED",
      claimId: input.claimId,
      receiptId: receipt.id,
      receiptStatus: "EXTRACTED",
      filename,
      replyText: `已完成“${filename}”识别，请在工作台确认：${claimUrl(input.deps.publicAppUrl, input.claimId)}`,
    };
  } catch (error) {
    const deterministic = error instanceof AttachmentValidationError;
    return {
      kind: "RETRYABLE_FAILURE",
      claimId: input.claimId,
      retryable: !deterministic,
      replyText: `${deterministic ? "附件仅支持 JPG、PNG 或 PDF，大小不超过 20MB，且文件内容需与格式一致。" : "附件暂未处理完成，请稍后重试或在工作台上传。"} ${claimUrl(input.deps.publicAppUrl, input.claimId)}`,
    };
  }
}

class AttachmentValidationError extends Error {}

function validateDownloadedAttachment(mimeType: string, bytes: Uint8Array): void {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new AttachmentValidationError();
  const signatures: Record<string, number[]> = {
    "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  };
  const signature = signatures[mimeType];
  if (!signature || !signature.every((byte, index) => bytes[index] === byte)) throw new AttachmentValidationError();
}

function safeFilename(value: string): string {
  return value.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "receipt";
}

async function createAndLink(employeeId: string, chatId: string, deps: ProcessFeishuEventDeps): Promise<Pick<Claim, "id">> {
  const claim = await deps.createClaimDraft({ actorId: employeeId });
  await deps.events.setConversation(employeeId, chatId, claim.id);
  return claim;
}

function linked(claimId: string, publicAppUrl: string, label: string): FeishuProcessingResult {
  return { kind: "CLAIM_LINKED", claimId, replyText: `${label}：${claimUrl(publicAppUrl, claimId)}` };
}

function claimUrl(publicAppUrl: string, claimId: string): string {
  return `${publicAppUrl}/claims/${encodeURIComponent(claimId)}`;
}

function safeReply(agent: AgentTurnResult): string {
  return agent.reply.trim().slice(0, 1_000) || "已生成补充建议。";
}

function assertEventMatchesMessage(event: StoredInboundEvent, message: FeishuInboundMessage) {
  if (event.messageId !== message.messageId || event.chatId !== message.chatId || event.senderOpenId !== message.senderOpenId) {
    throw new Error("feishu message metadata mismatch");
  }
}
