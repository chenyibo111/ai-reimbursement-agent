import { expect, it } from "vitest";

import { ensureEmployeeIdentity } from "@/src/application/ensure-employee-identity";

it("maps first Web OAuth and first Agent contact for one open ID to the same employee projection", async () => {
  const employees = new Map<string, { id: string; displayName: string }>();
  const projections: Array<{ employeeId: string; role: string }> = [];
  const deps = {
    employees: {
      findByFeishuUserId: async (openId: string) => employees.get(openId) ?? null,
      create: async ({ feishuUserId, displayName }: { feishuUserId: string; displayName: string }) => {
        const employee = { id: "employee-1", displayName };
        employees.set(feishuUserId, employee);
        return employee;
      },
    },
    resolveRole: () => "EMPLOYEE" as const,
    provision: async (input: { employeeId: string; role: string }) => { projections.push(input); },
  };

  const web = await ensureEmployeeIdentity({ openId: "ou_same_user", displayName: "测试员工" }, deps);
  const agent = await ensureEmployeeIdentity({ openId: "ou_same_user" }, deps);

  expect(web.id).toBe("employee-1");
  expect(agent.id).toBe(web.id);
  expect(projections).toEqual([
    expect.objectContaining({ employeeId: "employee-1", displayName: "测试员工", role: "EMPLOYEE" }),
    expect.objectContaining({ employeeId: "employee-1", displayName: "测试员工", role: "EMPLOYEE" }),
  ]);
});

it("does not issue access when the employee projection fails", async () => {
  await expect(ensureEmployeeIdentity({ openId: "ou_unavailable", displayName: "测试员工" }, {
    employees: { findByFeishuUserId: async () => null, create: async () => ({ id: "employee-2" }) },
    resolveRole: () => "EMPLOYEE" as const,
    provision: async () => { throw new Error("IDENTITY_PROVISIONING_UNAVAILABLE"); },
  })).rejects.toThrow("IDENTITY_PROVISIONING_UNAVAILABLE");
});
