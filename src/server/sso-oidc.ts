import * as oidc from "openid-client";

const issuer = "http://localhost:4444/";
const clientId = "reimbursement-web";

export type SsoIdentity = { subject: string; sid: string; openId: string; displayName?: string; expiresAt: Date };

export function validateSsoIdentityClaims(claims: Record<string, unknown>, now = new Date()): SsoIdentity {
  const subject = claims.sub;
  const sid = claims.sid;
  const openId = claims.feishu_open_id;
  const exp = claims.exp;
  if (typeof subject !== "string" || !subject.startsWith("fs_") || typeof sid !== "string" || !sid || typeof openId !== "string" || !openId.startsWith("ou_") || !Number.isInteger(exp) || typeof exp !== "number" || exp <= Math.floor(now.getTime() / 1000)) {
    throw new Error("incomplete SSO identity");
  }
  return { subject, sid, openId, displayName: typeof claims.name === "string" ? claims.name : undefined, expiresAt: new Date(exp * 1000) };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function ssoRedirectUri(): string {
  return required("REIMBURSEMENT_SSO_REDIRECT_URI");
}

export function ssoPostLogoutUri(): string {
  return required("REIMBURSEMENT_SSO_POST_LOGOUT_URI");
}

async function configuration(): Promise<oidc.Configuration> {
  const customFetch: oidc.CustomFetch = (resource, options) => {
    const url = new URL(resource);
    const dialAddress = process.env.HYDRA_DIAL_ADDRESS?.trim();
    if (url.host === "localhost:4444" && dialAddress) url.host = dialAddress;
    return fetch(url, options as unknown as RequestInit);
  };
  return oidc.discovery(new URL(issuer), clientId, { token_endpoint_auth_method: "none" }, oidc.None(), {
    [oidc.customFetch]: customFetch,
    execute: [oidc.allowInsecureRequests],
  });
}

export async function beginSsoAuthorization() {
  const config = await configuration();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: ssoRedirectUri(),
    response_type: "code",
    scope: "openid profile feishu_identity",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url, verifier, state, nonce };
}

export async function completeSsoAuthorization(callbackUrl: URL, pending: { verifier: string; state: string; nonce: string }) {
  const config = await configuration();
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  if (!tokens.id_token) throw new Error("missing ID Token");
  const claims = tokens.claims();
  if (!claims) throw new Error("missing ID Token claims");
  return { idToken: tokens.id_token, identity: validateSsoIdentityClaims(claims as Record<string, unknown>) };
}

export async function ssoLogoutUrl(idToken: string): Promise<URL> {
  const config = await configuration();
  return oidc.buildEndSessionUrl(config, { id_token_hint: idToken, post_logout_redirect_uri: ssoPostLogoutUri() });
}

export async function ssoJwksUrl(): Promise<URL> {
  const metadata = (await configuration()).serverMetadata();
  if (!metadata.jwks_uri) throw new Error("missing SSO JWKS URL");
  return new URL(metadata.jwks_uri);
}
