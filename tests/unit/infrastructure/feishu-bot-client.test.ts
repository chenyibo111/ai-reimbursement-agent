import { expect, it } from "vitest";

import { createFeishuBotClient, FeishuBotClientError } from "@/src/infrastructure/feishu/feishu-bot-client";

it("downloads a message resource with the tenant token only in the authorization header", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuBotClient({
    appId: "cli_test",
    appSecret: "app-secret",
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), init });
      if (calls.length === 1) return json({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="receipt.png"' },
      });
    },
  });

  await expect(client.downloadResource("om_123", "img_456", "image")).resolves.toMatchObject({
    filename: "receipt.png",
    mimeType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
  });
  expect(calls[1]).toMatchObject({
    url: "https://open.feishu.cn/open-apis/im/v1/messages/om_123/resources/img_456?type=image",
    init: { headers: { authorization: "Bearer tenant-token" } },
  });
  expect(calls[1].url).not.toContain("tenant-token");
  expect(JSON.stringify(calls[0].init)).not.toContain("tenant-token");
});

it("normalizes a message response without retaining the original provider payload", async () => {
  const client = createFeishuBotClient({
    appId: "cli_test",
    appSecret: "app-secret",
    fetch: async (_url, init) => {
      if (init?.method === "POST") return json({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      return json({
        code: 0,
        data: {
          items: [{
            message_id: "om_123",
            chat_id: "oc_123",
            chat_type: "group",
            message_type: "text",
            content: '{"text":"报销午餐"}',
            sender: { id: "ou_employee" },
            mentions: [{ id: { open_id: "ou_bot" } }],
          }],
        },
      });
    },
  });

  await expect(client.getMessage("om_123")).resolves.toEqual({
    messageId: "om_123",
    chatId: "oc_123",
    chatType: "group",
    senderOpenId: "ou_employee",
    messageType: "text",
    text: "报销午餐",
    mentions: ["ou_bot"],
    attachments: [],
  });
});

it("classifies provider failures without exposing response bodies or credentials", async () => {
  const client = createFeishuBotClient({
    appId: "cli_test",
    appSecret: "super-secret",
    fetch: async () => json({ code: 99991663, msg: "provider body contains super-secret" }, 401),
  });

  await expect(client.replyText("om_123", "已收到")).rejects.toEqual(new FeishuBotClientError("UNAUTHORIZED"));
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
