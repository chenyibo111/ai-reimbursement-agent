import { NextResponse } from "next/server";

import { syncPolicySource } from "@/src/application/sync-policy-source";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createFeishuPolicyDocumentClient } from "@/src/infrastructure/feishu/feishu-policy-document-client";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export async function POST(request: Request, context: { params: Promise<{ sourceId: string }> }) { try { const actorId = getSessionActorId(request); if (!process.env.DATABASE_URL) throw new Error("database configuration is missing"); const prisma = createPrismaClient(process.env.DATABASE_URL); const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true } }); const config = loadConfig(process.env); if (!employee || !isPolicyAdmin(actorId, employee, config)) throw new Error("forbidden"); if (!config.feishuOAuth) throw new Error("Feishu OAuth is not configured"); const { sourceId } = await context.params; const result = await syncPolicySource({ actorId, sourceId }, { sources: new PrismaPolicyKnowledgeRepository(prisma), documents: createFeishuPolicyDocumentClient({ appId: config.feishuOAuth.appId, appSecret: config.feishuOAuth.appSecret }), embeddings: createEmbeddingProvider(config), now: () => new Date() }); return NextResponse.json(result); } catch (error) { const message = error instanceof Error ? error.message : "request failed"; return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : 500 }); } }
