import type { AgentTurnResult } from "@/src/application/run-agent-turn";
import type { Claim } from "@/src/domain/claim";
import { parseFeishuBotCommand, type FeishuInboundMessage } from "@/src/domain/feishu-bot";
import type { FeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";

export type FeishuProcessingResult =
  | { kind: "IGNORED" }
  | { kind: "LOGIN_REQUIRED"; replyText: string }
  | { kind: "CLAIM_LINKED"; claimId: string | null; replyText: string }
  | { kind: "AGENT_REPLIED"; claimId: string; replyText: string }
  | { kind: "ATTACHMENT_QUEUED"; claimId: string; replyText: string }
  | { kind: "RETRYABLE_FAILURE"; replyText: string };

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
};

export async function processFeishuEvent(
  input: { eventId: string },
  deps: ProcessFeishuEventDeps,
): Promise<FeishuProcessingResult> {
  const event = await deps.events.findInboundByEventId(input.eventId);
  if (!event?.messageId) return { kind: "RETRYABLE_FAILURE", replyText: "消息正在重试处理，请稍后在工作台查看。" };

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
    return {
      kind: "ATTACHMENT_QUEUED",
      claimId: claim.id,
      replyText: `附件已接收，正在识别。完成后请在工作台确认：${claimUrl(deps.publicAppUrl, claim.id)}`,
    };
  }
  if (!message.text.trim()) return linked(claim.id, deps.publicAppUrl, "已关联报销草稿");

  const agent = await deps.runAgentTurn({ actorId: employee.id, claimId: claim.id, message: message.text });
  return {
    kind: "AGENT_REPLIED",
    claimId: claim.id,
    replyText: `${safeReply(agent)}\n\n请在工作台确认或补充信息：${claimUrl(deps.publicAppUrl, claim.id)}`,
  };
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
