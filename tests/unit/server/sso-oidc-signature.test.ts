import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import { completeSsoAuthorization } from "@/src/server/sso-oidc";

afterEach(() => vi.unstubAllGlobals());

it("rejects a correctly shaped ID Token signed by an untrusted key over local HTTP", async () => {
  const trusted = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(trusted.publicKey), kid: "trusted-key", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const forged = await new SignJWT({
    sid: "hydra-session-1",
    feishu_open_id: "ou_alice",
    nonce: "expected-nonce",
  }).setProtectedHeader({ alg: "RS256", kid: "trusted-key" })
    .setIssuer("http://localhost:4444/")
    .setAudience("reimbursement-web")
    .setSubject("fs_alice")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(untrusted.privateKey);
  const metadata = {
    issuer: "http://localhost:4444/",
    authorization_endpoint: "http://localhost:4444/oauth2/auth",
    token_endpoint: "http://localhost:4444/oauth2/token",
    jwks_uri: "http://localhost:4444/.well-known/jwks.json",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
  const fetcher = vi.fn(async (resource: RequestInfo | URL) => {
    const path = new URL(resource.toString()).pathname;
    if (path === "/.well-known/openid-configuration") return Response.json(metadata);
    if (path === "/oauth2/token") return Response.json({ access_token: "access-token", token_type: "Bearer", expires_in: 3600, id_token: forged });
    if (path === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    throw new Error(`unexpected OIDC path: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);

  await expect(completeSsoAuthorization(
    new URL("http://localhost:8088/api/auth/sso/callback?code=code-1&state=expected-state"),
    { verifier: "a".repeat(43), state: "expected-state", nonce: "expected-nonce" },
  )).rejects.toThrow();
  expect(fetcher.mock.calls.some(([resource]) => new URL(resource.toString()).pathname === "/.well-known/jwks.json")).toBe(true);
});
