import { expect, it } from "vitest";

import {
  createReimbursementJwt,
  parseSafeReturnTo,
  resolveFeishuRole,
  validateRoleConfiguration,
} from "@/src/server/reimbursement-auth";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    FEISHU_ADMIN_OPEN_IDS: "ou-admin",
    FEISHU_FINANCE_REVIEWER_OPEN_IDS: "ou-finance",
    ...overrides,
  };
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

it("resolves a Feishu open ID to the configured role or employee default", () => {
  expect(resolveFeishuRole("ou-admin", env())).toBe("ADMIN");
  expect(resolveFeishuRole("ou-finance", env())).toBe("FINANCE_REVIEWER");
  expect(resolveFeishuRole("ou-employee", env())).toBe("EMPLOYEE");
});

it("rejects an open ID appearing in both privileged role lists", () => {
  expect(() => validateRoleConfiguration(env({ FEISHU_FINANCE_REVIEWER_OPEN_IDS: "ou-finance,ou-admin" }))).toThrow("role configuration overlaps");
});

it("issues a fifteen minute Web JWT with the reimbursement audience", () => {
  const token = createReimbursementJwt({ subject: "employee-1", role: "EMPLOYEE", channel: "web" }, "signing-secret", new Date("2026-10-07T00:00:00Z"));

  expect(claims(token)).toMatchObject({
    sub: "employee-1",
    role: "EMPLOYEE",
    aud: "reimbursement-api",
    channel: "web",
    iat: 1_791_331_200,
    exp: 1_791_332_100,
  });
});

it("requires an agent JWT to carry a stable tool-call JTI", () => {
  expect(() => createReimbursementJwt({ subject: "employee-1", role: "EMPLOYEE", channel: "agent" }, "signing-secret")).toThrow("agent jti is required");
});

it("accepts only safe local OAuth return paths", () => {
  expect(parseSafeReturnTo("/claims/claim-1?from=login#receipt")).toBe("/claims/claim-1?from=login#receipt");
  for (const value of [null, "", "claims", "//evil.example", "https://evil.example", "\\\\evil.example", "/%2f%2fevil.example"]) {
    expect(parseSafeReturnTo(value)).toBe("/claims");
  }
});
