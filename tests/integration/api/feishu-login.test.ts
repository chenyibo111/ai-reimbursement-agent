import { expect, it } from "vitest";

import { GET } from "@/app/api/auth/feishu/callback/route";

it("rejects a callback when state differs from the HttpOnly cookie", async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  const response = await GET(new Request("http://localhost/api/auth/feishu/callback?code=code&state=wrong", { headers: { cookie: "reimbursement_oauth_state=expected" } }));
  expect(response.status).toBe(400);
});
