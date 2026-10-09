import { z } from "zod";

import type { FeishuMessageContent, FeishuReplyCard } from "@/src/domain/feishu-bot";

export type FeishuBotClient = {
  getMessage(messageId: string): Promise<FeishuMessageContent>;
  downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  sendText(chatId: string, text: string, uuid: string): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
  replyCard(messageId: string, card: FeishuReplyCard): Promise<void>;
};

export type FeishuBotClientErrorCode = "UNAVAILABLE" | "UNAUTHORIZED" | "RESOURCE_NOT_FOUND" | "REJECTED" | "INVALID_RESPONSE";

export class FeishuBotClientError extends Error {
  constructor(public readonly code: FeishuBotClientErrorCode, public readonly providerCode?: string) {
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
    if (!response.ok) throw providerError(response.status);
    if (isProviderFailure(payload)) throw providerRejection(payload);
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
      if (!response.ok) throw providerError(response.status);
      if (isProviderFailure(payload)) throw providerRejection(payload);
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
    async sendText(chatId, text, uuid) {
      const response = await authorizedFetch("/open-apis/im/v1/messages?receive_id_type=chat_id", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }), uuid }),
      });
      const payload = await parseJson(response);
      if (!response.ok) throw providerError(response.status);
      if (isProviderFailure(payload)) throw providerRejection(payload);
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
    if (!response.ok) throw providerError(response.status);
    if (isProviderFailure(payload)) throw providerRejection(payload);
  }
}

const tenantTokenSchema = z.object({ code: z.union([z.literal(0), z.literal("0")]).optional(), tenant_access_token: z.string().min(1), expire: z.number().int().positive().default(7200) }).passthrough();
const messageEnvelopeSchema = z.object({
  code: z.union([z.literal(0), z.literal("0")]).optional(),
  data: z.object({
    items: z.array(z.object({
      message_id: z.string().min(1),
      chat_id: z.string().min(1),
      msg_type: z.string().min(1),
      body: z.object({ content: z.string() }),
      sender: z.object({
        id: z.string().optional(),
        sender_id: z.object({ open_id: z.string().optional() }).optional(),
      }).passthrough(),
    }).passthrough()).min(1),
  }),
}).passthrough();

function normalizeMessage(message: z.infer<typeof messageEnvelopeSchema>["data"]["items"][number]): FeishuMessageContent {
  const senderOpenId = message.sender.id ?? message.sender.sender_id?.open_id;
  if (!senderOpenId) throw new FeishuBotClientError("INVALID_RESPONSE");
  const content = parseContent(message.body.content);
  const elements = message.msg_type === "post" ? postElements(content) : [content];
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    senderOpenId,
    messageType: message.msg_type,
    text: message.msg_type === "post" ? elements.flatMap((element) => typeof element.text === "string" ? [element.text] : []).join("") : typeof content.text === "string" ? content.text : "",
    attachments: elements.flatMap(attachmentsFromElement),
  };
}

function postElements(content: Record<string, unknown>): Record<string, unknown>[] {
  for (const localized of Object.values(content)) {
    if (!isRecord(localized) || !Array.isArray(localized.content)) continue;
    return localized.content.flatMap((row) => Array.isArray(row)
      ? row.filter(isRecord)
      : []);
  }
  return [];
}

function attachmentsFromElement(element: Record<string, unknown>) {
  const imageKey = element.image_key;
  const fileKey = element.file_key;
  return [
    ...(typeof imageKey === "string" && imageKey ? [{ fileKey: imageKey, resourceType: "image" as const, filename: typeof element.image_name === "string" ? element.image_name : undefined }] : []),
    ...(typeof fileKey === "string" && fileKey ? [{ fileKey, resourceType: "file" as const, filename: typeof element.file_name === "string" ? element.file_name : undefined }] : []),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function providerRejection(payload: unknown): FeishuBotClientError {
  const providerCode = typeof payload === "object" && payload !== null && "code" in payload
    ? String(payload.code)
    : undefined;
  return new FeishuBotClientError("REJECTED", providerCode);
}

function filenameFromDisposition(value: string | null): string | undefined {
  const match = value?.match(/filename="?([^";]+)"?/i);
  return match?.[1];
}
