import { z } from "zod";

const resolvedMember = z.object({ employeeId: z.string().min(1), role: z.enum(["EMPLOYEE", "FINANCE_REVIEWER", "ADMIN"]) });

export function createMemberIdentityClient(config: {
  baseUrl: string;
  serviceKey: string;
  appId: string;
  tenantKey: string;
  fetch?: typeof fetch;
}) {
  const fetcher = config.fetch ?? fetch;
  if (!config.baseUrl || !config.serviceKey || !config.appId || !config.tenantKey) throw new Error("member identity client is not configured");
  return {
    async resolve(openId: string, userId: string, displayName: string): Promise<{ id: string; role: "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN" }> {
      if (!openId || !userId) throw new Error("identity resolution failed");
      const response = await fetcher(`${config.baseUrl.replace(/\/$/, "")}/internal/v1/employee-identities/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Auth-Provisioning-Key": config.serviceKey },
        body: JSON.stringify({ tenantKey: config.tenantKey, userId, appId: config.appId, openId, displayName }),
      });
      if (!response.ok) throw new Error("identity resolution failed");
      const parsed = resolvedMember.safeParse(await response.json());
      if (!parsed.success) throw new Error("identity resolution failed");
      return { id: parsed.data.employeeId, role: parsed.data.role };
    },
  };
}
