import type { FeishuIdentity } from "@/src/infrastructure/auth/feishu-oauth";
import { ensureEmployeeIdentity, type ResolvedEmployeeIdentity } from "@/src/application/ensure-employee-identity";
import { createEmployeeProvisioner } from "@/src/infrastructure/reimbursement/employee-provisioning-client";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { resolveFeishuRole } from "@/src/server/reimbursement-auth";

export async function ensureFeishuIdentity(identity: FeishuIdentity): Promise<ResolvedEmployeeIdentity> {
  const databaseUrl = required("DATABASE_URL");
  const prisma = createPrismaClient(databaseUrl);
  return ensureEmployeeIdentity(identity, {
    employees: {
      findByFeishuUserId: (feishuUserId) => prisma.employee.findUnique({ where: { feishuUserId } }),
      create: ({ feishuUserId, displayName }) => prisma.employee.create({ data: { id: crypto.randomUUID(), feishuUserId, displayName } }),
    },
    resolveRole: (openId) => resolveFeishuRole(openId, process.env),
    provision: createEmployeeProvisioner({ baseUrl: required("REIMBURSEMENT_API_URL"), provisioningKey: required("REIMBURSEMENT_AUTH_PROVISIONING_KEY") }).provision,
  });
}

export async function ensureStoredEmployee(employeeId: string): Promise<ResolvedEmployeeIdentity | null> {
  const prisma = createPrismaClient(required("DATABASE_URL"));
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, displayName: true, feishuUserId: true } });
  if (!employee?.feishuUserId) return null;
  return ensureFeishuIdentity({ openId: employee.feishuUserId, displayName: employee.displayName });
}

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
