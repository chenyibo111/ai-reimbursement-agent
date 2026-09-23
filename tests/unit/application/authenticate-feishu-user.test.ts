import { expect, it } from "vitest";

import { authenticateFeishuUser } from "@/src/application/authenticate-feishu-user";

it("maps a repeated openId to one employee", async () => {
  const employees = new Map<string, { id: string; feishuUserId: string }>();
  const deps = {
    employees: {
      findByFeishuUserId: async (id: string) => employees.get(id) ?? null,
      create: async (input: { feishuUserId: string }) => {
        const employee = { id: "employee-1", feishuUserId: input.feishuUserId };
        employees.set(input.feishuUserId, employee);
        return employee;
      },
    },
  };
  const identity = { openId: "ou_123", displayName: "测试员工" };
  expect(await authenticateFeishuUser(identity, deps)).toEqual(await authenticateFeishuUser(identity, deps));
});
