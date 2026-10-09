import { expect, it } from "vitest";

import { authenticateFeishuUser } from "@/src/application/authenticate-feishu-user";
import { ensureEmployeeIdentity } from "@/src/application/ensure-employee-identity";

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

it("projects an authenticated Feishu employee into the reimbursement API before issuing access", async () => {
  const calls: unknown[] = [];
  const employee = await ensureEmployeeIdentity(
    { openId: "ou_123", displayName: "测试员工" },
    {
      employees: {
        findByFeishuUserId: async () => null,
        create: async () => ({ id: "employee-1" }),
      },
      resolveRole: () => "ADMIN",
      provision: async (input) => { calls.push(input); },
    },
  );

  expect(employee).toEqual({ id: "employee-1", displayName: "测试员工", openId: "ou_123", role: "ADMIN", isActive: true });
  expect(calls).toEqual([{ employeeId: "employee-1", displayName: "测试员工", feishuOpenId: "ou_123", role: "ADMIN", isActive: true }]);
});
