import { expect, it } from "vitest";

import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";

it("uses only trimmed Feishu open IDs from the policy administrator allowlist", () => {
  const config = loadConfig({
    POLICY_ADMIN_FEISHU_OPEN_IDS: " ou_finance_a, ,not-an-open-id,ou_finance_b ",
  });

  expect([...config.policyAdminOpenIds]).toEqual(["ou_finance_a", "ou_finance_b"]);
});

it("allows only the authenticated employee whose Feishu open ID is allowlisted", () => {
  const config = loadConfig({ POLICY_ADMIN_FEISHU_OPEN_IDS: "ou_finance_a" });

  expect(isPolicyAdmin("employee-a", { id: "employee-a", feishuUserId: "ou_finance_a" }, config)).toBe(true);
  expect(isPolicyAdmin("employee-b", { id: "employee-a", feishuUserId: "ou_finance_a" }, config)).toBe(false);
  expect(isPolicyAdmin("employee-a", { id: "employee-a", feishuUserId: null }, config)).toBe(false);
  expect(isPolicyAdmin("employee-a", { id: "employee-a", feishuUserId: "ou_employee" }, config)).toBe(false);
});
