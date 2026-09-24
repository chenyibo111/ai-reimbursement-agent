import { expect, it } from "vitest";

import { createSessionToken, getSessionActorId } from "@/src/server/session";

function requestFor(token: string) {
  return new Request("http://localhost", { headers: { cookie: `reimbursement_session=${token}` } });
}

it("accepts an unexpired signed session and rejects an expired session", () => {
  process.env.SESSION_SECRET = "secret";
  const token = createSessionToken("employee-1", "secret", new Date("2026-09-24T00:00:00Z"));

  expect(getSessionActorId(requestFor(token), new Date("2026-10-01T00:00:00Z"))).toBe("employee-1");
  expect(() => getSessionActorId(requestFor(token), new Date("2026-10-25T00:00:00Z"))).toThrow("unauthenticated");
});
