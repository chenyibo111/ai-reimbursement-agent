import { z } from "zod";

import type { FeishuInboundMessage, FeishuReplyCard } from "@/src/domain/feishu-bot";

export type FeishuBotClient = {
  getMessage(messageId: string): Promise<FeishuInboundMessage>;
  downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  replyText(messageId: string, text: string): Promise<void>;
  replyCard(messageId: string, card: FeishuReplyCard): Promise<void>;
};

export type FeishuBotClientErrorCode = "UNAVAILABLE" | "UNAUTHORIZED" | "RESOURCE_NOT_FOUND" | "INVALID_RESPONSE";

export class FeishuBotClientError extends Error {
  constructor(public readonly code: FeishuBotClientErrorCode) {
    super(`feishu bot client ${code}`);
  }
}

export function createFeishuBotClient(config: {
  appId: string;
  appSecret: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}): FeishuBotClient {
  const fetcher = config.fetch ?? fetch;
  const baseUrl = (config.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function token(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    const response = await safeFetch(fetcher, `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    const payload = await parseJson(response);
    if (!response.ok || isProviderFailure(payload)) throw providerError(response.status);
    const parsed = tenantTokenSchema.safeParse(payload);
    if (!parsed.success) throw new FeishuBotClientError("INVALID_RESPONSE");
    cachedToken = { value: parsed.data.tenant_access_token, expiresAt: Date.now() + Math.max(60, parsed.data.expire - 60) * 1000 };
    return cachedToken.value;
  }

  async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await token();
    return safeFetch(fetcher, `${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
    });
  }

  return {
    async getMessage(messageId) {
      const response = await authorizedFetch(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
      const payload = await parseJson(response);
      if (!response.ok || isProviderFailure(payload)) throw providerError(response.status);
      const parsed = messageEnvelopeSchema.safeParse(payload);
      if (!parsed.success) throw new FeishuBotClientError("INVALID_RESPONSE");
      return normalizeMessage(parsed.data.data.items[0]);
    },
    async downloadResource(messageId, fileKey, type) {
      const response = await authorizedFetch(
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`,
      );
      if (!response.ok) throw providerError(response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        filename: filenameFromDisposition(response.headers.get("content-disposition")) ?? `${fileKey}.${type === "image" ? "jpg" : "bin"}`,
        mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
      };
    },
    async replyText(messageId, text) {
      await reply(messageId, "text", JSON.stringify({ text }));
    },
    async replyCard(messageId, card) {
      await reply(messageId, "interactive", JSON.stringify(card));
    },
  };

  async function reply(messageId: string, msgType: "text" | "interactive", content: string) {
    const response = await authorizedFetch(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_type: msgType, content }),
    });
    const payload = await parseJson(response);
    if (!response.ok || isProviderFailure(payload)) throw providerError(response.status);
  }
}

const tenantTokenSchema = z.object({ code: z.union([z.literal(0), z.literal("0")]).optional(), tenant_access_token: z.string().min(1), expire: z.number().int().positive().default(7200) }).passthrough();
const messageEnvelopeSchema = z.object({
  code: z.union([z.literal(0), z.literal("0")]).optional(),
  data: z.object({
    items: z.array(z.object({
      message_id: z.string().min(1),
      chat_id: z.string().min(1),
      chat_type: z.enum(["p2p", "group"]),
      message_type: z.string().min(1),
      content: z.string(),
      sender: z.object({
        id: z.string().optional(),
        sender_id: z.object({ open_id: z.string().optional() }).optional(),
      }).passthrough(),
      mentions: z.array(z.object({ id: z.object({ open_id: z.string().optional() }).optional() }).passthrough()).default([]),
    }).passthrough()).min(1),
  }),
}).passthrough();

function normalizeMessage(message: z.infer<typeof messageEnvelopeSchema>["data"]["items"][number]): FeishuInboundMessage {
  const senderOpenId = message.sender.id ?? message.sender.sender_id?.open_id;
  if (!senderOpenId) throw new FeishuBotClientError("INVALID_RESPONSE");
  const content = parseContent(message.content);
  const imageKey = content.image_key;
  const fileKey = content.file_key;
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    senderOpenId,
    messageType: message.message_type,
    text: typeof content.text === "string" ? content.text : "",
    mentions: message.mentions.flatMap((mention) => mention.id?.open_id ? [mention.id.open_id] : []),
    attachments: [
      ...(typeof imageKey === "string" && imageKey ? [{ fileKey: imageKey, resourceType: "image" as const, filename: typeof content.image_name === "string" ? content.image_name : undefined }] : []),
      ...(typeof fileKey === "string" && fileKey ? [{ fileKey, resourceType: "file" as const, filename: typeof content.file_name === "string" ? content.file_name : undefined }] : []),
    ],
  };
}

function parseContent(content: string): Record<string, unknown> {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error("invalid");
    return parsed.data;
  } catch {
    throw new FeishuBotClientError("INVALID_RESPONSE");
  }
}

async function safeFetch(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch {
    throw new FeishuBotClientError("UNAVAILABLE");
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FeishuBotClientError("INVALID_RESPONSE");
  }
}

function isProviderFailure(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "code" in payload && (payload.code !== 0 && payload.code !== "0");
}

function providerError(status: number): FeishuBotClientError {
  if (status === 401 || status === 403) return new FeishuBotClientError("UNAUTHORIZED");
  if (status === 404) return new FeishuBotClientError("RESOURCE_NOT_FOUND");
  return new FeishuBotClientError(status >= 500 || status === 0 ? "UNAVAILABLE" : "INVALID_RESPONSE");
}

function filenameFromDisposition(value: string | null): string | undefined {
  const match = value?.match(/filename="?([^";]+)"?/i);
  return match?.[1];
}
