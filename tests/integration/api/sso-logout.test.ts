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

it("starts Hydra global logout while retaining local state until central revocation", async () => {
  const response = await GET(new Request("http://localhost:8088/api/auth/sso/logout", { headers: { cookie: "reimbursement_sso_session=opaque-key" } }));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain("localhost:4444/oauth2/sessions/logout");
  expect(mocks.deleteBySid).not.toHaveBeenCalled();
  expect(response.headers.getSetCookie()).toHaveLength(0);
});

it("keeps logout retryable if Hydra cannot provide an end-session URL", async () => {
  mocks.logoutUrl.mockRejectedValue(new Error("Hydra unavailable"));
  const response = await GET(new Request("http://localhost:8088/api/auth/sso/logout", { headers: { cookie: "reimbursement_sso_session=opaque-key" } }));
  expect(response.status).toBe(503);
  expect(response.headers.getSetCookie()).toHaveLength(0);
  expect(mocks.deleteBySid).not.toHaveBeenCalled();
});

it("does not claim logout completed when SSO status is unavailable", async () => {
  mocks.active.mockRejectedValue(new Error("SSO unavailable"));
  const response = await GET(new Request("http://localhost:8088/api/auth/sso/logout", { headers: { cookie: "reimbursement_sso_session=opaque-key" } }));
  expect(response.status).toBe(503);
  expect(mocks.deleteBySid).not.toHaveBeenCalled();
});
