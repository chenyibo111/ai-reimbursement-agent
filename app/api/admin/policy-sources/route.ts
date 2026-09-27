import { NextResponse } from "next/server";

import { parsePolicySourceUrl } from "@/src/domain/policy-source";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export async function GET(request: Request) { try { const { prisma } = await admin(request); return NextResponse.json({ sources: await prisma.policySource.findMany({ orderBy: { updatedAt: "desc" } }) }); } catch (error) { return failure(error); } }
export async function POST(request: Request) {
  try {
    const { actorId, prisma } = await admin(request); const body = await request.json() as { url?: unknown; title?: unknown };
    if (typeof body.url !== "string" || typeof body.title !== "string" || !body.title.trim()) throw new Error("invalid policy source");
    const locator = parsePolicySourceUrl(body.url); const source = await new PrismaPolicyKnowledgeRepository(prisma).createSource({ ...locator, token: locator.token, title: body.title, actorId });
    return NextResponse.json(source, { status: 201 });
  } catch (error) { return failure(error); }
}
async function admin(request: Request) { const actorId = getSessionActorId(request); if (!process.env.DATABASE_URL) throw new Error("database configuration is missing"); const prisma = createPrismaClient(process.env.DATABASE_URL); const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true } }); if (!employee || !isPolicyAdmin(actorId, employee, loadConfig(process.env))) throw new Error("forbidden"); return { actorId, prisma }; }
function failure(error: unknown) { const message = error instanceof Error ? error.message : "request failed"; return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "invalid policy source" || message === "不支持的飞书政策来源链接" ? 400 : 500 }); }
