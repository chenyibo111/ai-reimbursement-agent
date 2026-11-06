import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createAgentAdminHandler } from "@/src/server/agent-admin-http";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
if (!databaseUrl.includes("_test")) throw new Error("policy administration integration tests require a test database");
const prisma = createPrismaClient(databaseUrl);
const actorId = `retirement-admin-${Date.now()}`;
const token = `Docx${Date.now()}Abcd`;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await prisma.$connect();
  server = createServer(createAgentAdminHandler({ prisma, serviceKey: "test-internal-service-key" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.reviewCase.deleteMany({ where: { policySource: { createdByEmployeeId: actorId } } });
  await prisma.asyncJob.deleteMany({ where: { policySource: { createdByEmployeeId: actorId } } });
  await prisma.policyDocumentSnapshot.deleteMany({ where: { source: { createdByEmployeeId: actorId } } });
  await prisma.policySourceAuditEvent.deleteMany({ where: { actorId } });
  await prisma.policySource.deleteMany({ where: { createdByEmployeeId: actorId } });
  await prisma.$disconnect();
});

function call(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { method, headers: { "Content-Type": "application/json", "X-Agent-Admin-Service-Key": "test-internal-service-key", "X-Agent-Actor-ID": actorId, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

it("rejects direct access without the internal key or verified actor", async () => {
  expect((await call("/api/v1/admin/policy-sources", "GET", undefined, { "X-Agent-Admin-Service-Key": "wrong" })).status).toBe(401);
  expect((await call("/api/v1/admin/policy-sources", "GET", undefined, { "X-Agent-Actor-ID": "" })).status).toBe(401);
});

it("validates, deduplicates and lists explicit Feishu sources without leaking the token", async () => {
  const invalid = await call("/api/v1/admin/policy-sources", "POST", { title: "制度", url: `https://evil.example/docx/${token}` });
  expect(invalid.status).toBe(400);
  const url = `https://corp.feishu.cn/docx/${token}`;
  const created = await call("/api/v1/admin/policy-sources", "POST", { title: "差旅制度", url });
  expect(created.status).toBe(201);
  const source = await created.json() as { id: string; sectionCount: number | null; chunkCount: number | null };
  expect(source).toMatchObject({ sectionCount: null, chunkCount: null });
  expect(source).not.toHaveProperty("resourceToken");
  expect((await call("/api/v1/admin/policy-sources", "POST", { title: "重复", url })).status).toBe(409);
  const listed = await (await call("/api/v1/admin/policy-sources")).json() as { sources: Array<{ id: string; lastJob: unknown }> };
  expect(listed.sources.find((item) => item.id === source.id)).toMatchObject({ lastJob: null });
  const audit = await prisma.policySourceAuditEvent.findFirst({ where: { sourceId: source.id, actorId, action: "CREATED" } });
  expect(audit).not.toBeNull();
});

it("queues one sync job, exposes its durable result and blocks disabled sources", async () => {
  const source = await prisma.policySource.findFirstOrThrow({ where: { createdByEmployeeId: actorId } });
  const path = `/api/v1/admin/policy-sources/${source.id}`;
  const first = await call(`${path}/sync`, "POST");
  expect(first.status).toBe(202);
  const job = await first.json() as { jobId: string; jobStatus: string };
  expect(job.jobStatus).toBe("PENDING");
  const repeated = await (await call(`${path}/sync`, "POST")).json() as { jobId: string };
  expect(repeated.jobId).toBe(job.jobId);
  const pending = await (await call(`${path}/jobs/${job.jobId}`)).json() as { status: string; resultKind: string | null };
  expect(pending).toMatchObject({ status: "PENDING", resultKind: null });
  await prisma.asyncJob.update({ where: { id: job.jobId }, data: { status: "SUCCEEDED", result: { status: "UNCHANGED", sectionCount: 0, chunkCount: 0 } } });
  const done = await (await call(`${path}/jobs/${job.jobId}`)).json() as { status: string; resultKind: string | null };
  expect(done).toMatchObject({ status: "SUCCEEDED", resultKind: "UNCHANGED" });
  expect((await call(`/api/v1/admin/policy-sources/wrong/jobs/${job.jobId}`)).status).toBe(404);
  expect((await call(path, "PATCH", { enabled: false })).status).toBe(200);
  expect((await call(`${path}/sync`, "POST")).status).toBe(409);
});
