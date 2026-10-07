import { afterEach, expect, it } from "vitest";

import { POST } from "@/app/api/auth/dev-login/route";

const originalNodeEnv = process.env.NODE_ENV;
const originalDevDemoEmployeeId = process.env.DEV_DEMO_EMPLOYEE_ID;
const originalDevDemoEmployeeName = process.env.DEV_DEMO_EMPLOYEE_NAME;
const originalDevDemoFeishuOpenId = process.env.DEV_DEMO_FEISHU_OPEN_ID;
const originalSessionSecret = process.env.SESSION_SECRET;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  }
  restoreEnv("DEV_DEMO_EMPLOYEE_ID", originalDevDemoEmployeeId);
  restoreEnv("DEV_DEMO_EMPLOYEE_NAME", originalDevDemoEmployeeName);
  restoreEnv("DEV_DEMO_FEISHU_OPEN_ID", originalDevDemoFeishuOpenId);
  restoreEnv("SESSION_SECRET", originalSessionSecret);
});

it("returns 404 for demo login in production", async () => {
  Reflect.set(process.env, "NODE_ENV", "production");
  expect((await POST(new Request("http://localhost/api/auth/dev-login", { method: "POST" }))).status).toBe(404);
});

it("requires a Feishu open ID before creating a development session", async () => {
  Reflect.set(process.env, "NODE_ENV", "development");
  Reflect.set(process.env, "DEV_DEMO_EMPLOYEE_ID", "employee-1");
  Reflect.set(process.env, "DEV_DEMO_EMPLOYEE_NAME", "Demo Employee");
  Reflect.deleteProperty(process.env, "DEV_DEMO_FEISHU_OPEN_ID");
  Reflect.set(process.env, "SESSION_SECRET", "test-session-secret");

  const response = await POST(new Request("http://localhost/api/auth/dev-login", { method: "POST" }));

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ error: "development login is not configured" });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    Reflect.set(process.env, name, value);
  }
}
