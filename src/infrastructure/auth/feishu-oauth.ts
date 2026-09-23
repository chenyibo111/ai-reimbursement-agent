export type FeishuIdentity = { openId: string; unionId?: string; displayName?: string };
export type FeishuOAuthClient = { exchangeCode(code: string): Promise<FeishuIdentity> };

export function createFeishuOAuthClient(config: { appId: string; appSecret: string; redirectUri: string; fetch?: typeof fetch; tokenEndpoint?: string; userInfoEndpoint?: string }): FeishuOAuthClient {
  const fetcher = config.fetch ?? fetch;
  const tokenEndpoint = config.tokenEndpoint ?? "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
  const userInfoEndpoint = config.userInfoEndpoint ?? "https://open.feishu.cn/open-apis/authen/v1/user_info";
  return {
    async exchangeCode(code) {
      const response = await fetcher(tokenEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri }) });
      if (!response.ok) throw new Error("feishu oauth exchange failed");
      const tokenPayload = await response.json() as { code?: unknown; data?: { access_token?: unknown } };
      if (tokenPayload.code !== undefined && tokenPayload.code !== 0 && tokenPayload.code !== "0") throw new Error("feishu oauth exchange failed");
      const accessToken = tokenPayload.data?.access_token;
      if (typeof accessToken !== "string" || !accessToken) throw new Error("feishu oauth exchange failed");

      const userInfoResponse = await fetcher(userInfoEndpoint, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!userInfoResponse.ok) throw new Error("feishu oauth exchange failed");
      const payload = await userInfoResponse.json() as { code?: unknown; data?: { open_id?: unknown; union_id?: unknown; name?: unknown } };
      if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new Error("feishu oauth exchange failed");
      const identity = payload.data;
      if (!identity || typeof identity.open_id !== "string" || !identity.open_id) throw new Error("feishu identity is incomplete");
      return { openId: identity.open_id, unionId: typeof identity.union_id === "string" ? identity.union_id : undefined, displayName: typeof identity.name === "string" ? identity.name : undefined };
    },
  };
}
