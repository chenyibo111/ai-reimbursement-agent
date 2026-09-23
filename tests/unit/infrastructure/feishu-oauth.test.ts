import { expect, it } from "vitest";

import { createFeishuOAuthClient } from "@/src/infrastructure/auth/feishu-oauth";

it("rejects an OAuth identity without openId", async () => {
  const client = createFeishuOAuthClient({ appId: "app", appSecret: "secret", redirectUri: "http://localhost/callback", fetch: async () => new Response(JSON.stringify({ data: { user: { name: "测试" } } }), { status: 200 }) });
  await expect(client.exchangeCode("code")).rejects.toThrow("feishu identity is incomplete");
});
