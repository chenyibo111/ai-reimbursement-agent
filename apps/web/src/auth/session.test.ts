import { describe, expect, it, vi } from "vitest";

import { createAuthSessionManager } from "./session";

const employee = { id: "employee-1", displayName: "测试员工", role: "EMPLOYEE" as const };

describe("createAuthSessionManager", () => {
  it("throttles failed activity reports during an SSO rollout", async () => {
    let current = new Date("2026-11-14T01:00:00.000Z");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("token-1", "2026-11-14T01:15:00.000Z"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const manager = createAuthSessionManager({ fetcher, now: () => current });
    await manager.initialize();
    await manager.recordActivity();
    await manager.recordActivity();
    expect(fetcher).toHaveBeenCalledTimes(2);
    current = new Date("2026-11-14T01:01:01.000Z");
    await manager.recordActivity();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("reports real input at most once a minute and treats an expired SSO session as logged out", async () => {
    let current = new Date("2026-11-14T01:00:00.000Z");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("token-1", "2026-11-14T01:15:00.000Z"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const manager = createAuthSessionManager({ fetcher, now: () => current });
    await manager.initialize();
    await manager.recordActivity();
    await manager.recordActivity();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/auth/activity", { method: "POST", credentials: "same-origin", headers: { "X-SSO-Activity": "1" } });
    current = new Date("2026-11-14T01:01:01.000Z");
    await manager.recordActivity();
    expect(manager.snapshot()).toEqual({ status: "unauthenticated" });
  });
  it("keeps the access token only in memory after startup", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse("token-1", "2026-10-08T01:00:00.000Z"));
    const manager = createAuthSessionManager({ fetcher, now: () => new Date("2026-10-08T00:00:00.000Z") });

    await manager.initialize();

    expect(manager.snapshot()).toEqual({ status: "authenticated", accessToken: "token-1", expiresAt: "2026-10-08T01:00:00.000Z", employee });
    expect(manager.getAccessToken()).toBe("token-1");
  });

  it("marks an initial 401 as unauthenticated without retaining a token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 }));
    const manager = createAuthSessionManager({ fetcher });

    await manager.initialize();

    expect(manager.snapshot()).toEqual({ status: "unauthenticated" });
    expect(manager.getAccessToken()).toBeNull();
  });

  it("refreshes one minute before expiry", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("token-1", "2026-10-08T00:00:30.000Z"))
      .mockResolvedValueOnce(tokenResponse("token-2", "2026-10-08T00:15:00.000Z"));
    const manager = createAuthSessionManager({ fetcher, now: () => new Date("2026-10-08T00:00:00.000Z") });

    await manager.initialize();
    await manager.refreshIfExpiring();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(manager.getAccessToken()).toBe("token-2");
  });

  it("clears in-memory authentication state when logging out", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("token-1", "2026-10-08T01:00:00.000Z"));
    const navigate = vi.fn();
    const manager = createAuthSessionManager({ fetcher, navigate });
    await manager.initialize();

    await manager.logout();

    expect(manager.snapshot()).toEqual({ status: "logging-out" });
    expect(manager.getAccessToken()).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/api/auth/sso/logout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function tokenResponse(accessToken: string, expiresAt: string) {
  return new Response(JSON.stringify({ accessToken, expiresAt, employee }), { status: 200, headers: { "Content-Type": "application/json" } });
}
