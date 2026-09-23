export type FeishuIdentity = { openId: string; unionId?: string; displayName?: string };
export type FeishuOAuthClient = { exchangeCode(code: string): Promise<FeishuIdentity> };

export function createFeishuOAuthClient(config: { appId: string; appSecret: string; redirectUri: string; fetch?: typeof fetch; tokenEndpoint?: string }): FeishuOAuthClient {
  const fetcher = config.fetch ?? fetch;
  const tokenEndpoint = config.tokenEndpoint ?? "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token";
  return {
    async exchangeCode(code) {
      const response = await fetcher(tokenEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri }) });
      if (!response.ok) throw new Error("feishu oauth exchange failed");
      const payload = await response.json() as { data?: { open_id?: unknown; union_id?: unknown; name?: unknown; user?: { open_id?: unknown; union_id?: unknown; name?: unknown } } };
      const identity = payload.data?.user ?? payload.data;
      if (!identity || typeof identity.open_id !== "string" || !identity.open_id) throw new Error("feishu identity is incomplete");
      return { openId: identity.open_id, unionId: typeof identity.union_id === "string" ? identity.union_id : undefined, displayName: typeof identity.name === "string" ? identity.name : undefined };
    },
  };
}
