import { expect, it } from "vitest";

import { GET } from "@/app/api/auth/session/route";
import { createSessionToken } from "@/src/server/session";

it("returns the authenticated employee from a persistent session", async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET);

  const response = await GET(new Request("http://localhost/api/auth/session", { headers: { cookie: `reimbursement_session=${token}` } }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ employeeId: "employee-1" });
});

it("rejects a missing session", async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  expect((await GET(new Request("http://localhost/api/auth/session"))).status).toBe(401);
});
