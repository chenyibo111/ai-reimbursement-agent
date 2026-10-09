import type { EmployeeProvisioner } from "@/src/application/ensure-employee-identity";

export class EmployeeProvisioningUnavailableError extends Error { constructor() { super("IDENTITY_PROVISIONING_UNAVAILABLE"); } }

export function createEmployeeProvisioner(config: { baseUrl: string; provisioningKey: string; fetch?: typeof fetch }): EmployeeProvisioner {
  const fetcher = config.fetch ?? fetch;
  return {
    async provision(input) {
      const response = await fetcher(`${config.baseUrl.replace(/\/$/, "")}/internal/v1/employees/${encodeURIComponent(input.employeeId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-Auth-Provisioning-Key": config.provisioningKey },
        body: JSON.stringify({ displayName: input.displayName, feishuOpenId: input.feishuOpenId, role: input.role, isActive: input.isActive }),
      }).catch(() => null);
      if (!response?.ok) throw new EmployeeProvisioningUnavailableError();
    },
  };
}
