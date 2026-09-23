import { afterEach, expect, it } from "vitest";

import { POST } from "@/app/api/auth/dev-login/route";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  }
});

it("returns 404 for demo login in production", async () => {
  Reflect.set(process.env, "NODE_ENV", "production");
  expect((await POST(new Request("http://localhost/api/auth/dev-login", { method: "POST" }))).status).toBe(404);
});
