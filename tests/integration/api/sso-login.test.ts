import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  ensureEmployee: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/src/server/sso-oidc", () => ({
  beginSsoAuthorization: mocks.begin,
  completeSsoAuthorization: mocks.complete,
  ssoRedirectUri: () => "http://localhost:8088/api/auth/sso/callback",
}));
vi.mock("@/src/server/employee-identity", () => ({ ensureFeishuIdentity: mocks.ensureEmployee }));
vi.mock("@/src/server/sso-session-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/sso-session-repository")>();
  return { ...actual, createConfiguredSsoSessionService: () => ({ create: mocks.createSession }) };
});

import { GET as login } from "@/app/api/auth/sso/login/route";
import { GET as callback } from "@/app/api/auth/sso/callback/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue({ url: new URL("http://localhost:4444/oauth2/auth?client_id=reimbursement-web"), state: "state-1", nonce: "nonce-1", verifier: "verifier-1" });
});

it("starts OIDC and keeps state, nonce, verifier in HttpOnly cookies", async () => {
  const response = await login(new Request("http://localhost:8088/api/auth/sso/login?returnTo=%2Fclaims"));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain("localhost:4444/oauth2/auth");
  const cookies = response.headers.getSetCookie().join("\n");
  expect(cookies).toContain("sso_oauth_state=state-1");
  expect(cookies).toContain("sso_oauth_nonce=nonce-1");
  expect(cookies).toContain("sso_oauth_verifier=verifier-1");
  expect(cookies).toContain("HttpOnly");
});

it("rejects an invalid callback state without provisioning an employee", async () => {
  const response = await callback(new Request("http://localhost:8088/api/auth/sso/callback?code=code&state=wrong", { headers: { cookie: "sso_oauth_state=expected; sso_oauth_nonce=nonce-1; sso_oauth_verifier=verifier-1" } }));
  expect(response.status).toBe(400);
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.ensureEmployee).not.toHaveBeenCalled();
});

it("provisions a verified SSO member and creates an opaque React session", async () => {
  mocks.complete.mockResolvedValue({ idToken: "signed-id-token", identity: { subject: "fs_alice", sid: "sid-1", openId: "ou_alice", displayName: "Alice", expiresAt: new Date("2026-11-02T01:00:00Z") } });
  mocks.ensureEmployee.mockResolvedValue({ id: "employee-1" });
  mocks.createSession.mockResolvedValue("opaque-session-key");
  const response = await callback(new Request("http://localhost:8088/api/auth/sso/callback?code=code&state=state-1", { headers: { cookie: "sso_oauth_state=state-1; sso_oauth_nonce=nonce-1; sso_oauth_verifier=verifier-1; sso_oauth_return_to=/claims" } }));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("http://localhost:8088/claims");
  expect(mocks.ensureEmployee).toHaveBeenCalledWith({ openId: "ou_alice", displayName: "Alice" });
  expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ employeeId: "employee-1", sid: "sid-1", idToken: "signed-id-token" }));
  expect(response.headers.getSetCookie().join("\n")).toContain("reimbursement_sso_session=opaque-session-key");
});

it("uses the registered edge callback URI when Next sees its container URL", async () => {
  mocks.complete.mockResolvedValue({ idToken: "signed-id-token", identity: { subject: "fs_alice", sid: "sid-1", openId: "ou_alice", expiresAt: new Date("2026-11-02T01:00:00Z") } });
  mocks.ensureEmployee.mockResolvedValue({ id: "employee-1" });
  mocks.createSession.mockResolvedValue("opaque-session-key");
  await callback(new Request("http://localhost:3000/api/auth/sso/callback?code=code&state=state-1", { headers: { cookie: "sso_oauth_state=state-1; sso_oauth_nonce=nonce-1; sso_oauth_verifier=verifier-1" } }));
  expect(mocks.complete.mock.calls[0]?.[0].toString()).toBe("http://localhost:8088/api/auth/sso/callback?code=code&state=state-1");
});
