import type { AppConfig } from "@/src/server/config";

export function assertClaimOwner(actorId: string, claim: { employeeId: string }) {
  if (actorId !== claim.employeeId) {
    throw new Error("forbidden");
  }
}

export function isPolicyAdmin(
  actorId: string,
  employee: { id: string; feishuUserId: string | null },
  config: AppConfig,
): boolean {
  return employee.id === actorId
    && employee.feishuUserId !== null
    && config.policyAdminOpenIds.has(employee.feishuUserId);
}
