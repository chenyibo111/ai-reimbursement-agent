import { expect, it } from "vitest";

import { sessionCookie } from "@/src/server/auth-cookies";

it("marks production session cookies Secure and HttpOnly", () => {
  const cookie = sessionCookie("employee-1", "secret", true);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");
});

it("keeps a session cookie for thirty days", () => {
  expect(sessionCookie("employee-1", "secret", false)).toContain("Max-Age=2592000");
});
