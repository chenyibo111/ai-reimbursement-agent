import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { Prisma, type PolicySource, type PrismaClient } from "@/generated/prisma/client";
import { parsePolicySourceUrl } from "@/src/domain/policy-source";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { policySyncResultKind, toPolicySourceResponse } from "@/src/server/policy-source-response";

const sourcePath = /^\/api\/v1\/admin\/policy-sources(?:\/([A-Za-z0-9_-]+)(?:\/(sync|jobs\/([A-Za-z0-9_-]+)))?)?$/;
const maxBodyBytes = 64 * 1024;

class AdminHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function createAgentAdminHandler(input: { prisma: PrismaClient; serviceKey: string }): RequestListener {
  if (!input.serviceKey.trim()) throw new Error("AGENT_ADMIN_SERVICE_KEY is required");
  return (request, response) => {
    void handle(request, response, input).catch((error: unknown) => {
      if (error instanceof AdminHttpError) { sendJSON(response, error.status, { code: error.code, message: error.message }); return; }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { sendJSON(response, 409, { code: "POLICY_SOURCE_EXISTS", message: "该飞书文档已登记" }); return; }
      sendJSON(response, 500, { code: "INTERNAL_ERROR", message: "操作未完成，请稍后重试" });
    });
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, input: { prisma: PrismaClient; serviceKey: string }) {
  const key = request.headers["x-agent-admin-service-key"];
  const actorId = request.headers["x-agent-actor-id"];
  if (typeof key !== "string" || !sameSecret(key, input.serviceKey) || typeof actorId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(actorId)) {
    throw new AdminHttpError(401, "UNAUTHENTICATED", "政策管理身份无效");
  }
  const url = new URL(request.url ?? "/", "http://agent-admin.internal");
  const match = sourcePath.exec(url.pathname);
  if (!match || url.search) throw new AdminHttpError(404, "NOT_FOUND", "未找到政策来源操作");
  const [, sourceId, suffix, jobId] = match;
  const prisma = input.prisma;
  if (!sourceId && request.method === "GET") {
    const sources = await prisma.policySource.findMany({ orderBy: { updatedAt: "desc" } });
    sendJSON(response, 200, { sources: await Promise.all(sources.map((source) => sourceView(prisma, source))) });
    return;
  }
  if (!sourceId && request.method === "POST") {
    const body = await readBody(request);
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 160 || typeof body.url !== "string") throw new AdminHttpError(400, "INVALID_REQUEST", "请填写有效的来源标题和飞书链接");
    let locator;
    try { locator = parsePolicySourceUrl(body.url); }
    catch { throw new AdminHttpError(400, "INVALID_POLICY_SOURCE_URL", "仅支持已授权的飞书 Docx 或 Wiki 链接"); }
    const source = await new PrismaPolicyKnowledgeRepository(prisma).createSourceWithAudit({ ...locator, title: body.title, actorId });
    sendJSON(response, 201, await sourceView(prisma, source));
    return;
  }
  if (sourceId && !suffix && request.method === "PATCH") {
    const body = await readBody(request);
    if (typeof body.enabled !== "boolean") throw new AdminHttpError(400, "INVALID_REQUEST", "来源状态参数无效");
    await prisma.$transaction(async (tx) => {
      const updated = await tx.policySource.updateMany({ where: { id: sourceId }, data: { enabled: body.enabled as boolean } });
      if (!updated.count) throw new AdminHttpError(404, "NOT_FOUND", "未找到政策来源");
      await tx.policySourceAuditEvent.create({ data: { sourceId, actorId, action: body.enabled ? "ENABLED" : "DISABLED", outcome: "SUCCEEDED" } });
    });
    const source = await prisma.policySource.findUniqueOrThrow({ where: { id: sourceId } });
    sendJSON(response, 200, await sourceView(prisma, source));
    return;
  }
  if (sourceId && suffix === "sync" && request.method === "POST") {
    const source = await prisma.policySource.findFirst({ where: { id: sourceId, enabled: true }, select: { id: true } });
    if (!source) throw new AdminHttpError(409, "POLICY_SOURCE_UNAVAILABLE", "来源不存在或已停用");
    const job = await new PrismaAsyncJobRepository(prisma).enqueueJob({ kind: "POLICY_SOURCE_SYNC", policySourceId: sourceId, actorId });
    await prisma.policySourceAuditEvent.create({ data: { sourceId, actorId, action: "SYNC_REQUESTED", outcome: job.status, jobId: job.id } });
    sendJSON(response, 202, { sourceId, jobId: job.id, jobStatus: job.status });
    return;
  }
  if (sourceId && jobId && request.method === "GET") {
    const job = await prisma.asyncJob.findFirst({ where: { id: jobId, policySourceId: sourceId, kind: "POLICY_SOURCE_SYNC" }, select: { id: true, status: true, failureCode: true, result: true } });
    if (!job) throw new AdminHttpError(404, "NOT_FOUND", "未找到同步任务");
    sendJSON(response, 200, { jobId: job.id, status: job.status, failureCode: job.failureCode, resultKind: policySyncResultKind(job.result) });
    return;
  }
  throw new AdminHttpError(404, "NOT_FOUND", "未找到政策来源操作");
}

async function sourceView(prisma: PrismaClient, source: PolicySource) {
  const [active, job] = await Promise.all([
    prisma.policyDocumentSnapshot.findFirst({ where: { sourceId: source.id, status: "ACTIVE" }, orderBy: { activatedAt: "desc" }, select: { _count: { select: { sections: true, chunks: true } } } }),
    prisma.asyncJob.findFirst({ where: { policySourceId: source.id, kind: "POLICY_SOURCE_SYNC" }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, failureCode: true, result: true } }),
  ]);
  return toPolicySourceResponse({ ...source, snapshots: active ? [active] : [], asyncJobs: job ? [job] : [] });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new AdminHttpError(413, "INVALID_REQUEST", "请求内容过大");
    chunks.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body as Record<string, unknown>;
  } catch { throw new AdminHttpError(400, "INVALID_REQUEST", "请求格式无效"); }
}

function sameSecret(provided: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}

function sendJSON(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
