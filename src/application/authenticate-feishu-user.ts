import type { FeishuIdentity } from "@/src/infrastructure/auth/feishu-oauth";

export type AuthenticatedEmployee = { id: string };

export type FeishuEmployeeRepository = {
  findByFeishuUserId(feishuUserId: string): Promise<AuthenticatedEmployee | null>;
  create(input: { feishuUserId: string; displayName: string }): Promise<AuthenticatedEmployee>;
};

export async function authenticateFeishuUser(
  identity: FeishuIdentity,
  deps: { employees: FeishuEmployeeRepository },
): Promise<AuthenticatedEmployee> {
  const existing = await deps.employees.findByFeishuUserId(identity.openId);
  if (existing) return existing;

  return deps.employees.create({
    feishuUserId: identity.openId,
    displayName: identity.displayName || "飞书员工",
  });
}
