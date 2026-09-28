import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export async function POST(request: Request, context: { params: Promise<{ sourceId: string }> }) { try { const actorId = getSessionActorId(request); if (!process.env.DATABASE_URL) throw new Error("database configuration is missing"); const prisma = createPrismaClient(process.env.DATABASE_URL); const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true } }); const config = loadConfig(process.env); if (!employee || !isPolicyAdmin(actorId, employee, config)) throw new Error("forbidden"); const { sourceId } = await context.params; const source = await prisma.policySource.findFirst({ where: { id: sourceId, enabled: true }, select: { id: true } }); if (!source) throw new Error("policy source is unavailable"); const job = await new PrismaAsyncJobRepository(prisma).enqueueJob({ kind: "POLICY_SOURCE_SYNC", policySourceId: sourceId }); return NextResponse.json({ sourceId, jobId: job.id, jobStatus: job.status }, { status: 202 }); } catch (error) { const message = error instanceof Error ? error.message : "request failed"; return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "policy source is unavailable" ? 404 : 500 }); } }
