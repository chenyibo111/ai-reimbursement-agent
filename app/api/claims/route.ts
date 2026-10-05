import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createLogger } from "@/src/observability/logger";
import { withRequestContext } from "@/src/observability/request-context";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";
const logger = createLogger("web");

export async function GET(request: Request) {
  return withRequestContext(request, async ({ requestId, traceId, spanId }) => {
    const startedAt = Date.now();
    try {
      const actorId = getSessionActorId(request);
      const url = new URL(request.url);
      const query = url.searchParams.get("query")?.trim();
      const status = url.searchParams.get("status");
      const prisma = getPrisma();
      const claims = await prisma.claimDraft.findMany({
        where: {
          employeeId: actorId,
          ...(status && status !== "ALL" ? { status: status as "DRAFT" | "PROCESSING" | "NEEDS_INFORMATION" | "AWAITING_CONFIRMATION" | "SUBMITTED" } : {}),
          ...(query ? { purpose: { contains: query, mode: "insensitive" } } : {}),
        },
        include: { submissions: { select: { submissionNumber: true, submittedAt: true }, take: 1 }, expenseItems: { select: { amountCents: true } } },
        orderBy: { updatedAt: "desc" },
      });
      const items = claims.map((claim) => ({ id: claim.id, status: claim.status, purpose: claim.purpose, updatedAt: claim.updatedAt, totalAmountCents: claim.expenseItems.reduce((sum, item) => sum + item.amountCents, 0), submissionNumber: claim.submissions[0]?.submissionNumber ?? null, submittedAt: claim.submissions[0]?.submittedAt ?? null }));
      const response = NextResponse.json({ items, total: items.length });
      logger.info("http.request.completed", "报销单列表请求完成", { requestId, traceId, spanId, status: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      const response = errorResponse(error);
      logger.warn("http.request.failed", "报销单列表请求失败", { requestId, traceId, spanId, status: response.status, durationMs: Date.now() - startedAt, failureCode: getFailureCode(error) });
      return response;
    }
  });
}

export async function POST(request: Request) {
  return withRequestContext(request, async ({ requestId, traceId, spanId }) => {
    const startedAt = Date.now();
    try {
      const actorId = getSessionActorId(request);
      const body = (await request.json()) as { purpose?: unknown };
      if (body.purpose !== undefined && typeof body.purpose !== "string") {
        const response = NextResponse.json({ error: "purpose must be a string" }, { status: 400 });
        logger.warn("http.request.rejected", "创建报销单请求参数无效", { requestId, traceId, spanId, status: response.status, durationMs: Date.now() - startedAt, failureCode: "invalid_request" });
        return response;
      }

      const prisma = getPrisma();
      const claim = await createClaimDraft(
        { actorId, purpose: body.purpose },
        { claims: new PrismaClaimRepository(prisma), audit: createPrismaAuditEventWriter(prisma) },
      );

      const response = NextResponse.json(
        { id: claim.id, status: claim.status, version: claim.version },
        { status: 201 },
      );
      logger.info("http.request.completed", "创建报销单请求完成", { requestId, traceId, spanId, claimId: claim.id, status: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      const response = errorResponse(error);
      logger.warn("http.request.failed", "创建报销单请求失败", { requestId, traceId, spanId, status: response.status, durationMs: Date.now() - startedAt, failureCode: getFailureCode(error) });
      return response;
    }
  });
}

function getPrisma() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database configuration is missing");
  return createPrismaClient(connectionString);
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "request failed";
  const status = message === "unauthenticated" ? 401 : 500;
  return NextResponse.json({ error: message }, { status });
}

function getFailureCode(error: unknown) {
  return error instanceof Error && error.message === "unauthenticated" ? "unauthenticated" : "request_failed";
}
