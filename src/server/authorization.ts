import type { AppConfig } from "@/src/server/config";
import type { EmployeeRoleName } from "@/src/domain/async-job";

export function assertClaimOwner(actorId: string, claim: { employeeId: string }) {
  if (actorId !== claim.employeeId) {
    throw new Error("forbidden");
  }
}

export function isPolicyAdmin(
  actorId: string,
  employee: { id: string; feishuUserId: string | null; role?: EmployeeRoleName },
  config: AppConfig,
): boolean {
  if (employee.role === "ADMIN") return employee.id === actorId;
  if (employee.role === "FINANCE_REVIEWER") return false;
  return employee.id === actorId
    && employee.feishuUserId !== null
    && config.policyAdminOpenIds.has(employee.feishuUserId);
}
