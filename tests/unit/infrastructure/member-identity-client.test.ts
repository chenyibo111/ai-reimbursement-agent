import { expect, it } from "vitest";

import { createMemberIdentityClient } from "@/src/infrastructure/reimbursement/member-identity-client";

it("sends a verified bot member to the internal identity resolver", async () => {
  let called: { url: string; init?: RequestInit } | undefined;
  const client = createMemberIdentityClient({ baseUrl: "http://go-api:8080", serviceKey: "secret", appId: "cli_bot", tenantKey: "tenant-1", fetch: async (url, init) => {
    called = { url: url.toString(), init };
    return new Response(JSON.stringify({ employeeId: "employee-1", role: "EMPLOYEE" }), { status: 200 });
  } });
  await expect(client.resolve("ou_sender", "u_member", "成员")).resolves.toEqual({ id: "employee-1", role: "EMPLOYEE" });
  expect(called).toMatchObject({ url: "http://go-api:8080/internal/v1/employee-identities/resolve", init: {
    method: "POST", headers: { "X-Auth-Provisioning-Key": "secret" },
  } });
  expect(JSON.parse(String(called?.init?.body))).toMatchObject({ tenantKey: "tenant-1", userId: "u_member", appId: "cli_bot", openId: "ou_sender" });
});

it("does not fall back to a second employee when the resolver reports conflict", async () => {
  const client = createMemberIdentityClient({ baseUrl: "http://go-api:8080", serviceKey: "secret", appId: "cli_bot", tenantKey: "tenant-1", fetch: async () => new Response("{}", { status: 409 }) });
  await expect(client.resolve("ou_sender", "u_member", "成员")).rejects.toThrow("identity resolution failed");
});
