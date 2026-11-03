import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";

import { ssoJwksUrl } from "@/src/server/sso-oidc";

const logoutEvent = "http://schemas.openid.net/event/backchannel-logout";

export async function loadSsoBackchannelKeys(): Promise<JWTVerifyGetKey> {
  const url = await ssoJwksUrl();
  if (url.host === "localhost:4444" && process.env.HYDRA_DIAL_ADDRESS) url.host = process.env.HYDRA_DIAL_ADDRESS;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok) throw new Error("SSO JWKS unavailable");
  const jwks = await response.json();
  if (!jwks || typeof jwks !== "object" || !Array.isArray(jwks.keys)) throw new Error("invalid SSO JWKS");
  return createLocalJWKSet(jwks);
}

export async function verifySsoBackchannelLogout(raw: string, keys: JWTVerifyGetKey, now = new Date()): Promise<string> {
  if (!raw || raw.length > 16 * 1024) throw new Error("invalid logout token size");
  const header = decodeProtectedHeader(raw);
  if (header.alg !== "RS256" || !header.kid) throw new Error("invalid logout token header");
  const { payload } = await jwtVerify(raw, keys, {
    issuer: "http://localhost:4444/",
    audience: "reimbursement-web",
    algorithms: ["RS256"],
    currentDate: now,
  });
  const audience = payload.aud;
  const exactAudience = audience === "reimbursement-web" || (Array.isArray(audience) && audience.length === 1 && audience[0] === "reimbursement-web");
  const event = (payload.events as Record<string, unknown> | undefined)?.[logoutEvent];
  if (!exactAudience || typeof payload.sid !== "string" || !payload.sid || typeof payload.jti !== "string" || !payload.jti || !Number.isInteger(payload.iat) || typeof payload.iat !== "number" || Object.hasOwn(payload, "nonce") || !event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("invalid logout token claims");
  }
  const age = Math.floor(now.getTime() / 1000) - payload.iat;
  if (age < -60 || age > 300) throw new Error("stale logout token");
  return payload.sid;
}
