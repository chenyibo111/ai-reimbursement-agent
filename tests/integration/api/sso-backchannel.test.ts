import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), loadKeys: vi.fn(), deleteBySid: vi.fn() }));
vi.mock("@/src/server/sso-backchannel", () => ({ verifySsoBackchannelLogout: mocks.verify, loadSsoBackchannelKeys: mocks.loadKeys }));
vi.mock("@/src/server/sso-session-repository", () => ({ createConfiguredSsoSessionService: () => ({ deleteBySid: mocks.deleteBySid }) }));

import { POST } from "@/app/api/auth/sso/backchannel-logout/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadKeys.mockResolvedValue("keys");
  mocks.verify.mockResolvedValue("sid-1");
  mocks.deleteBySid.mockResolvedValue(undefined);
});

it("deletes only the sid from a verified Hydra back-channel notification", async () => {
  const response = await POST(new Request("http://localhost:8088/api/auth/sso/backchannel-logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "logout_token=signed-token" }));
  expect(response.status).toBe(204);
  expect(mocks.verify).toHaveBeenCalledWith("signed-token", "keys");
  expect(mocks.deleteBySid).toHaveBeenCalledWith("sid-1");
});

it("rejects a forged notification without deleting a session", async () => {
  mocks.verify.mockRejectedValue(new Error("bad signature"));
  const response = await POST(new Request("http://localhost:8088/api/auth/sso/backchannel-logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "logout_token=forged" }));
  expect(response.status).toBe(401);
  expect(mocks.deleteBySid).not.toHaveBeenCalled();
});
