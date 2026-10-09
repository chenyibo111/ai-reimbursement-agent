import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  ensureFeishuIdentity: vi.fn(),
}));

vi.mock("@/src/infrastructure/auth/feishu-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/infrastructure/auth/feishu-oauth")>();
  return { ...actual, createFeishuOAuthClient: () => ({ exchangeCode: mocks.exchangeCode }) };
});

vi.mock("@/src/server/employee-identity", () => ({ ensureFeishuIdentity: mocks.ensureFeishuIdentity }));

import { GET } from "@/app/api/auth/feishu/callback/route";
import { GET as login } from "@/app/api/auth/feishu/login/route";

it("redirects to a standard authorization-code request", async () => {
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_REDIRECT_URI = "http://localhost/api/auth/feishu/callback";

  const response = await login(new Request("http://localhost/api/auth/feishu/login"));
  const location = new URL(response.headers.get("location")!);
  expect(location.searchParams.get("client_id")).toBe("cli_test");
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("scope")).toBe("contact:user.base:readonly");
});

it("rejects a callback when state differs from the HttpOnly cookie", async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  const response = await GET(new Request("http://localhost/api/auth/feishu/callback?code=code&state=wrong", { headers: { cookie: "reimbursement_oauth_state=expected" } }));
  expect(response.status).toBe(400);
});

it("stores only a safe local return path during OAuth login", async () => {
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_REDIRECT_URI = "http://localhost/api/auth/feishu/callback";
  const response = await login(new Request("http://localhost/api/auth/feishu/login?returnTo=//evil.example"));
  expect(response.headers.getSetCookie().join("\n")).toContain("reimbursement_oauth_return_to=/claims");
});

it("returns to the configured public callback origin after a successful OAuth callback", async () => {
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_APP_SECRET = "test-app-secret";
  process.env.FEISHU_REDIRECT_URI = "http://localhost:8088/api/auth/feishu/callback";
  process.env.SESSION_SECRET = "test-session-secret";
  mocks.exchangeCode.mockResolvedValue({ openId: "ou_test", displayName: "Test User" });
  mocks.ensureFeishuIdentity.mockResolvedValue({ id: "employee-1", displayName: "Test User" });

  const response = await GET(new Request("http://localhost:3000/api/auth/feishu/callback?code=code&state=expected", {
    headers: { cookie: "reimbursement_oauth_state=expected; reimbursement_oauth_return_to=/claims" },
  }));

  expect(response.headers.get("location")).toBe("http://localhost:8088/claims");
});
