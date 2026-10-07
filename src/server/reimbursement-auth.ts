import { createHmac } from "node:crypto";

export type EmployeeRole = "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN";
export type ReimbursementChannel = "web" | "agent";

export type ReimbursementJwtInput = {
  subject: string;
  role: EmployeeRole;
  channel: ReimbursementChannel;
  jti?: string;
};

const jwtLifetimeSeconds = 15 * 60;
const defaultReturnTo = "/claims";

export function validateRoleConfiguration(env: NodeJS.ProcessEnv): void {
  const admin = openIds(env.FEISHU_ADMIN_OPEN_IDS);
  const reviewers = openIds(env.FEISHU_FINANCE_REVIEWER_OPEN_IDS);
  if (admin.some((openId) => reviewers.includes(openId))) {
    throw new Error("role configuration overlaps");
  }
}

export function resolveFeishuRole(openId: string, env: NodeJS.ProcessEnv): EmployeeRole {
  validateRoleConfiguration(env);
  if (openIds(env.FEISHU_ADMIN_OPEN_IDS).includes(openId)) return "ADMIN";
  if (openIds(env.FEISHU_FINANCE_REVIEWER_OPEN_IDS).includes(openId)) return "FINANCE_REVIEWER";
  return "EMPLOYEE";
}

export function createReimbursementJwt(input: ReimbursementJwtInput, secret: string, now = new Date()): string {
  if (!input.subject.trim()) throw new Error("jwt subject is required");
  if (!isRole(input.role)) throw new Error("jwt role is invalid");
  if (input.channel !== "web" && input.channel !== "agent") throw new Error("jwt channel is invalid");
  if (input.channel === "agent" && !input.jti?.trim()) throw new Error("agent jti is required");
  if (!secret) throw new Error("reimbursement jwt secret is required");

  const iat = Math.floor(now.getTime() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: input.subject,
    role: input.role,
    aud: "reimbursement-api",
    channel: input.channel,
    ...(input.jti?.trim() ? { jti: input.jti.trim() } : {}),
    iat,
    exp: iat + jwtLifetimeSeconds,
  });
  const signed = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signed).digest("base64url");
  return `${signed}.${signature}`;
}

export function parseSafeReturnTo(value: string | null): string {
  if (!value || value.length > 2_048 || !value.startsWith("/") || value.startsWith("//")) return defaultReturnTo;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\") || /[\r\n]/.test(decoded)) return defaultReturnTo;
    return value;
  } catch {
    return defaultReturnTo;
  }
}

function openIds(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function isRole(value: string): value is EmployeeRole {
  return value === "EMPLOYEE" || value === "FINANCE_REVIEWER" || value === "ADMIN";
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
