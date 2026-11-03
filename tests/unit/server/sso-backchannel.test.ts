import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";

import { verifySsoBackchannelLogout } from "@/src/server/sso-backchannel";

it("accepts only a signed Hydra logout event for this client and sid", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "key-1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const now = new Date("2026-11-02T00:00:00Z");
  const base = { iss: "http://localhost:4444/", aud: "reimbursement-web", iat: Math.floor(now.getTime() / 1000), jti: "logout-1", sid: "sid-1", events: { "http://schemas.openid.net/event/backchannel-logout": {} } };
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "key-1" }).sign(privateKey);

  expect(await verifySsoBackchannelLogout(await sign(base), keys, now)).toBe("sid-1");
  for (const change of [
    { aud: "demo-a" },
    { sid: "" },
    { nonce: "" },
    { events: { "http://schemas.openid.net/event/backchannel-logout": null } },
    { events: { "http://schemas.openid.net/event/backchannel-logout": "wrong" } },
  ]) {
    await expect(verifySsoBackchannelLogout(await sign({ ...base, ...change }), keys, now)).rejects.toThrow();
  }
});
