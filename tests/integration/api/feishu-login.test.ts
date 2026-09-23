import { expect, it } from "vitest";

import { GET } from "@/app/api/auth/feishu/callback/route";
import { GET as login } from "@/app/api/auth/feishu/login/route";

it("redirects to a standard authorization-code request", async () => {
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_REDIRECT_URI = "http://localhost/api/auth/feishu/callback";

  const response = await login(new Request("http://localhost/api/auth/feishu/login"));
  const location = new URL(response.headers.get("location")!);
  expect(location.searchParams.get("client_id")).toBe("cli_test");
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("scope")).toBe("contact:user.base:readonly");
});

it("rejects a callback when state differs from the HttpOnly cookie", async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  const response = await GET(new Request("http://localhost/api/auth/feishu/callback?code=code&state=wrong", { headers: { cookie: "reimbursement_oauth_state=expected" } }));
  expect(response.status).toBe(400);
});
