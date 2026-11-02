import { describe, expect, it } from "vitest";

import { validateSsoIdentityClaims } from "@/src/server/sso-oidc";

describe("SSO OIDC identity claims", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const valid = { sub: "fs_member", sid: "sid-1", feishu_open_id: "ou_alice", name: "Alice", exp: 1793581200 };

  it("accepts a verified token's member identity and session ID", () => {
    expect(validateSsoIdentityClaims(valid, now)).toEqual({ subject: "fs_member", sid: "sid-1", openId: "ou_alice", displayName: "Alice", expiresAt: new Date("2026-11-02T01:00:00Z") });
  });

  it.each([
    { sid: "" },
    { feishu_open_id: "" },
    { feishu_open_id: "not-an-open-id" },
    { sub: "" },
    { exp: 0 },
  ])("rejects incomplete or expired identity %j", (change) => {
    expect(() => validateSsoIdentityClaims({ ...valid, ...change }, now)).toThrow();
  });
});
