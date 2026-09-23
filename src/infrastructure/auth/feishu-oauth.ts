export type FeishuIdentity = { openId: string; unionId?: string; displayName?: string };
export type FeishuOAuthClient = { exchangeCode(code: string): Promise<FeishuIdentity> };

export class FeishuOAuthError extends Error {
  constructor(
    public readonly stage: "token_exchange" | "user_info",
    public readonly providerCode?: string | number,
  ) {
    super("feishu oauth exchange failed");
  }
}

export function createFeishuOAuthClient(config: { appId: string; appSecret: string; redirectUri: string; fetch?: typeof fetch; tokenEndpoint?: string; userInfoEndpoint?: string }): FeishuOAuthClient {
  const fetcher = config.fetch ?? fetch;
  const tokenEndpoint = config.tokenEndpoint ?? "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
  const userInfoEndpoint = config.userInfoEndpoint ?? "https://open.feishu.cn/open-apis/authen/v1/user_info";
  return {
    async exchangeCode(code) {
      const response = await fetcher(tokenEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri }) });
      const tokenPayload = await response.json().catch(() => ({})) as { code?: unknown; access_token?: unknown };
      if (!response.ok || (tokenPayload.code !== undefined && tokenPayload.code !== 0 && tokenPayload.code !== "0")) {
        throw new FeishuOAuthError("token_exchange", asProviderCode(tokenPayload.code));
      }
      const accessToken = tokenPayload.access_token;
      if (typeof accessToken !== "string" || !accessToken) throw new FeishuOAuthError("token_exchange", asProviderCode(tokenPayload.code));

      const userInfoResponse = await fetcher(userInfoEndpoint, { headers: { authorization: `Bearer ${accessToken}` } });
      const payload = await userInfoResponse.json().catch(() => ({})) as { code?: unknown; data?: { open_id?: unknown; union_id?: unknown; name?: unknown } };
      if (!userInfoResponse.ok || (payload.code !== undefined && payload.code !== 0 && payload.code !== "0")) {
        throw new FeishuOAuthError("user_info", asProviderCode(payload.code));
      }
      const identity = payload.data;
      if (!identity || typeof identity.open_id !== "string" || !identity.open_id) throw new Error("feishu identity is incomplete");
      return { openId: identity.open_id, unionId: typeof identity.union_id === "string" ? identity.union_id : undefined, displayName: typeof identity.name === "string" ? identity.name : undefined };
    },
  };
}

function asProviderCode(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
