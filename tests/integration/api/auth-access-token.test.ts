import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionActorId: vi.fn(),
  ensureStoredEmployee: vi.fn(),
  createReimbursementJwt: vi.fn(),
}));

vi.mock("@/src/server/session", () => ({ getSessionActorId: mocks.getSessionActorId }));
vi.mock("@/src/server/employee-identity", () => ({ ensureStoredEmployee: mocks.ensureStoredEmployee }));
vi.mock("@/src/server/reimbursement-auth", () => ({ createReimbursementJwt: mocks.createReimbursementJwt }));

import { GET } from "@/app/api/auth/access-token/route";

const originalSecret = process.env.REIMBURSEMENT_AUTH_HS256_SECRET;

afterEach(() => {
  vi.resetAllMocks();
  if (originalSecret === undefined) {
    Reflect.deleteProperty(process.env, "REIMBURSEMENT_AUTH_HS256_SECRET");
  } else {
    Reflect.set(process.env, "REIMBURSEMENT_AUTH_HS256_SECRET", originalSecret);
  }
});

it("returns a no-store Web token response without server-side secrets", async () => {
  Reflect.set(process.env, "REIMBURSEMENT_AUTH_HS256_SECRET", "test-auth-secret");
  mocks.getSessionActorId.mockReturnValue("employee-1");
  mocks.ensureStoredEmployee.mockResolvedValue({ id: "employee-1", displayName: "Demo Employee", openId: "ou_test", role: "EMPLOYEE", isActive: true });
  mocks.createReimbursementJwt.mockReturnValue("signed-web-token");

  const response = await GET(new Request("http://localhost/api/auth/access-token"));

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    accessToken: "signed-web-token",
    expiresAt: expect.any(String),
    employee: { id: "employee-1", displayName: "Demo Employee", role: "EMPLOYEE" },
  });
  expect(mocks.createReimbursementJwt).toHaveBeenCalledWith(
    { subject: "employee-1", role: "EMPLOYEE", channel: "web" },
    "test-auth-secret",
  );
});

it("returns an unauthenticated response when the session cannot be read", async () => {
  mocks.getSessionActorId.mockImplementation(() => { throw new Error("unauthenticated"); });

  const response = await GET(new Request("http://localhost/api/auth/access-token"));

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ code: "UNAUTHENTICATED", message: "请先登录后再操作" });
});
