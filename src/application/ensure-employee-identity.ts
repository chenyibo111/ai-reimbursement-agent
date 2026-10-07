import { authenticateFeishuUser, type FeishuEmployeeRepository } from "@/src/application/authenticate-feishu-user";
import type { FeishuIdentity } from "@/src/infrastructure/auth/feishu-oauth";
import type { EmployeeRole } from "@/src/server/reimbursement-auth";

export type ResolvedEmployeeIdentity = { id: string; displayName: string; openId: string; role: EmployeeRole; isActive: boolean };
export type EmployeeProvisioner = { provision(input: { employeeId: string; displayName: string; feishuOpenId: string; role: EmployeeRole; isActive: boolean }): Promise<void> };

export async function ensureEmployeeIdentity(identity: FeishuIdentity, deps: { employees: FeishuEmployeeRepository; resolveRole(openId: string): EmployeeRole; provision: EmployeeProvisioner["provision"] }): Promise<ResolvedEmployeeIdentity> {
  const employee = await authenticateFeishuUser(identity, { employees: deps.employees });
  const displayName = identity.displayName?.trim() || "飞书员工";
  const role = deps.resolveRole(identity.openId);
  const resolved = { id: employee.id, displayName, openId: identity.openId, role, isActive: true } satisfies ResolvedEmployeeIdentity;
  await deps.provision({ employeeId: resolved.id, displayName, feishuOpenId: resolved.openId, role, isActive: resolved.isActive });
  return resolved;
}
