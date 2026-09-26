export type FeishuAttachment = {
  fileKey: string;
  resourceType: "image" | "file";
  filename?: string;
};

export type FeishuInboundMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  messageType: string;
  text: string;
  mentions: string[];
  attachments: FeishuAttachment[];
};

export type FeishuMessageContent = Omit<FeishuInboundMessage, "chatType" | "mentions">;

export type FeishuReplyCard = Record<string, unknown>;

export type FeishuBotCommand = "NEW_CLAIM" | "VIEW_CURRENT_CLAIM" | "CHAT";

export function parseFeishuBotCommand(text: string): FeishuBotCommand {
  const normalized = text.trim();
  if (normalized === "新建报销") return "NEW_CLAIM";
  if (normalized === "查看当前草稿") return "VIEW_CURRENT_CLAIM";
  return "CHAT";
}
