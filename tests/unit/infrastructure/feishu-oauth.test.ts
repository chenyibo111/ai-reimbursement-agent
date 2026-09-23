import { expect, it } from "vitest";

import { createFeishuOAuthClient } from "@/src/infrastructure/auth/feishu-oauth";

it("rejects an OAuth identity without openId", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFeishuOAuthClient({
    appId: "app",
    appSecret: "secret",
    redirectUri: "http://localhost/callback",
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(
        JSON.stringify(calls.length === 1 ? { code: 0, access_token: "uat" } : { code: 0, data: { name: "测试" } }),
        { status: 200 },
      );
    },
  });
  await expect(client.exchangeCode("code")).rejects.toThrow("feishu identity is incomplete");
  expect(calls).toHaveLength(2);
  expect(calls[1].init?.headers).toEqual({ authorization: "Bearer uat" });
});

it("preserves a token-exchange provider code without exposing credentials", async () => {
  const client = createFeishuOAuthClient({
    appId: "app",
    appSecret: "secret",
    redirectUri: "http://localhost/callback",
    fetch: async () => new Response(JSON.stringify({ code: 99991663, msg: "invalid request" }), { status: 400 }),
  });

  await expect(client.exchangeCode("code")).rejects.toMatchObject({
    stage: "token_exchange",
    providerCode: 99991663,
  });
});
