import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  deleteBySid: vi.fn(),
  logoutUrl: vi.fn(),
}));

vi.mock("@/src/server/sso-session-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/sso-session-repository")>();
  return { ...actual, createConfiguredSsoSessionService: () => ({ active: mocks.active, deleteBySid: mocks.deleteBySid }) };
});
vi.mock("@/src/server/sso-oidc", () => ({
  ssoLogoutUrl: mocks.logoutUrl,
  ssoRedirectUri: () => "http://localhost:8088/api/auth/sso/callback",
}));

import { GET } from "@/app/api/auth/sso/logout/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active.mockResolvedValue({ employeeId: "employee-1", sid: "sid-1", idToken: "signed-id-token" });
  mocks.logoutUrl.mockResolvedValue(new URL("http://localhost:4444/oauth2/sessions/logout?id_token_hint=signed-id-token"));
  mocks.deleteBySid.mockResolvedValue(undefined);
});

it("starts Hydra global logout and deletes the local React session", async () => {
  const response = await GET(new Request("http://localhost:8088/api/auth/sso/logout", { headers: { cookie: "reimbursement_sso_session=opaque-key" } }));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain("localhost:4444/oauth2/sessions/logout");
  expect(mocks.deleteBySid).toHaveBeenCalledWith("sid-1");
  expect(response.headers.getSetCookie().join("\n")).toContain("reimbursement_sso_session=; Path=/api/auth; Max-Age=0");
});

it("does not claim logout completed when SSO status is unavailable", async () => {
  mocks.active.mockRejectedValue(new Error("SSO unavailable"));
  const response = await GET(new Request("http://localhost:8088/api/auth/sso/logout", { headers: { cookie: "reimbursement_sso_session=opaque-key" } }));
  expect(response.status).toBe(503);
  expect(mocks.deleteBySid).not.toHaveBeenCalled();
});
