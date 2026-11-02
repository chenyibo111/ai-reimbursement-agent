import type { SsoSessionRepository, SsoSessionRecord } from "@/src/server/sso-web-session";
import { createSsoWebSessionService } from "@/src/server/sso-web-session";
import { getCookie } from "@/src/server/auth-cookies";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { ssoRedirectUri } from "@/src/server/sso-oidc";

export const ssoSessionCookieName = "reimbursement_sso_session";

export function ssoSessionCookie(value: string, maxAge: number): string {
  return `${ssoSessionCookieName}=${value}; Path=/api/auth; Max-Age=${Math.max(0, maxAge)}; HttpOnly; SameSite=Lax${new URL(ssoRedirectUri()).protocol === "https:" ? "; Secure" : ""}`;
}

export function clearSsoSessionCookie(): string {
  return ssoSessionCookie("", 0);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createConfiguredSsoSessionService() {
  const prisma = createPrismaClient(required("DATABASE_URL"));
  const repository: SsoSessionRepository = {
    async find(idHash) {
      const row = await prisma.ssoWebSession.findUnique({ where: { idHash } });
      return row as SsoSessionRecord | null;
    },
    async put(record) {
      await prisma.ssoWebSession.create({ data: record });
    },
    async deleteBySid(sid) {
      await prisma.ssoWebSession.deleteMany({ where: { sid } });
    },
  };
  const statusUrl = process.env.SSO_STATUS_URL?.trim() || "http://localhost:9000/session-status";
  return createSsoWebSessionService({
    repository,
    secret: required("SESSION_SECRET"),
    checkStatus: async (idToken) => {
      const response = await fetch(statusUrl, { method: "POST", headers: { Authorization: `Bearer ${idToken}` }, signal: AbortSignal.timeout(5000), cache: "no-store" });
      return response.status;
    },
  });
}

export async function getActiveSsoWebSession(request: Request) {
  return createConfiguredSsoSessionService().active(getCookie(request, ssoSessionCookieName) ?? "");
}
