import { describe, expect, it, vi } from "vitest";

import { createSsoWebSessionService, SsoSessionError, type SsoSessionRecord } from "@/src/server/sso-web-session";

function repository() {
  const rows = new Map<string, SsoSessionRecord>();
  return {
    rows,
    find: async (idHash: string) => rows.get(idHash) ?? null,
    put: async (record: SsoSessionRecord) => { rows.set(record.idHash, record); },
    deleteBySid: async (sid: string) => { for (const [id, row] of rows) if (row.sid === sid) rows.delete(id); },
  };
}

describe("React SSO server session", () => {
  it("binds an opaque cookie to an encrypted ID Token and an active sid", async () => {
    const repo = repository();
    const checkStatus = vi.fn().mockResolvedValue(204);
    const service = createSsoWebSessionService({ repository: repo, secret: "a-very-long-test-session-secret", checkStatus, now: () => new Date("2026-11-02T00:00:00Z") });
    const cookie = await service.create({ employeeId: "employee-1", sid: "sid-1", idToken: "signed-id-token", expiresAt: new Date("2026-11-02T01:00:00Z") });

    expect(cookie).not.toContain("signed-id-token");
    expect([...repo.rows.values()][0]?.encryptedIdToken).not.toContain("signed-id-token");
    expect(await service.active(cookie)).toEqual({ employeeId: "employee-1", sid: "sid-1", idToken: "signed-id-token" });
    expect(checkStatus).toHaveBeenCalledWith("signed-id-token");
  });

  it("rejects a revoked session and fails closed when the status service is unavailable", async () => {
    const repo = repository();
    let status = 204;
    const service = createSsoWebSessionService({ repository: repo, secret: "a-very-long-test-session-secret", checkStatus: async () => status, now: () => new Date("2026-11-02T00:00:00Z") });
    const cookie = await service.create({ employeeId: "employee-1", sid: "sid-1", idToken: "signed-id-token", expiresAt: new Date("2026-11-02T01:00:00Z") });

    status = 401;
    await expect(service.active(cookie)).rejects.toMatchObject({ code: "UNAUTHENTICATED" } satisfies Partial<SsoSessionError>);
    status = 503;
    await expect(service.active(cookie)).rejects.toMatchObject({ code: "UNAVAILABLE" } satisfies Partial<SsoSessionError>);
    await service.deleteBySid("sid-1");
    await expect(service.active(cookie)).rejects.toMatchObject({ code: "UNAUTHENTICATED" } satisfies Partial<SsoSessionError>);
  });
});
