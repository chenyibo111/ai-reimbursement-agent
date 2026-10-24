import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/src/server/employee-identity", () => ({ ensureStoredEmployee: async (id: string) => ({ id, role: "EMPLOYEE", isActive: true }) }));

import { GET as getPrivateConversation } from "@/app/api/conversations/private/route";
import { POST as postMessage } from "@/app/api/conversations/private/messages/route";
import { POST as postAttachment } from "@/app/api/conversations/private/attachments/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.MODEL_PROVIDER = "fixture";
  process.env.REIMBURSEMENT_API_URL = "http://127.0.0.1:8088";
  process.env.REIMBURSEMENT_AGENT_SERVICE_KEY = "test-service-key";
  process.env.REIMBURSEMENT_AUTH_HS256_SECRET = "test-signing-secret";
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.agentMessage.deleteMany();
  await prisma.reimbursementIntake.deleteMany();
  await prisma.agentConversation.deleteMany();
  await prisma.employee.deleteMany({ where: { id: { startsWith: "conversation-api-" } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function session(employeeId: string) {
  return `reimbursement_session=${createSessionToken(employeeId, process.env.SESSION_SECRET!)}`;
}

it("returns only the signed-in employee private conversation", async () => {
  await prisma.employee.createMany({ data: [
    { id: "conversation-api-a", displayName: "员工 A" },
    { id: "conversation-api-b", displayName: "员工 B" },
  ] });

  const response = await getPrivateConversation(new Request("http://localhost/api/conversations/private", { headers: { cookie: session("conversation-api-a") } }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ messages: [], intake: null });
  expect(await prisma.agentConversation.count({ where: { employeeId: "conversation-api-b" } })).toBe(0);
});

it("routes a policy-only message through the employee private conversation without creating a claim", async () => {
  await prisma.employee.create({ data: { id: "conversation-api-a", displayName: "员工 A" } });

  const response = await postMessage(new Request("http://localhost/api/conversations/private/messages", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session("conversation-api-a") },
    body: JSON.stringify({ message: "报销制度是什么", turnId: "policy-turn-12345678" }),
  }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ reply: expect.any(String), intake: null });
  expect(await prisma.claimDraft.count({ where: { employeeId: "conversation-api-a" } })).toBe(0);
  await expect(prisma.agentMessage.count()).resolves.toBe(2);
});

it("rejects an unauthenticated message without writing conversation state", async () => {
  const response = await postMessage(new Request("http://localhost/api/conversations/private/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "开始报销", turnId: "start-turn-12345678" }),
  }));

  expect(response.status).toBe(401);
  await expect(prisma.agentConversation.count()).resolves.toBe(0);
});

it("rejects an attachment without a stable turn ID before creating an Intake", async () => {
  await prisma.employee.create({ data: { id: "conversation-api-a", displayName: "员工 A" } });
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], { type: "application/pdf" }), "unsafe.pdf");

  const response = await postAttachment(new Request("http://localhost/api/conversations/private/attachments", {
    method: "POST",
    headers: { cookie: session("conversation-api-a") },
    body: form,
  }));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "turnId is invalid" });
  expect(await prisma.claimDraft.count({ where: { employeeId: "conversation-api-a" } })).toBe(0);
  expect(await prisma.reimbursementIntake.count({ where: { employeeId: "conversation-api-a" } })).toBe(0);
});

it("fails closed when the Go API is not configured", async () => {
  const employeeId = `conversation-api-${crypto.randomUUID()}`;
  await prisma.employee.create({ data: { id: employeeId, displayName: "员工 A" } });
  const original = process.env.REIMBURSEMENT_API_URL;
  delete process.env.REIMBURSEMENT_API_URL;
  try {
    const response = await postMessage(new Request("http://localhost/api/conversations/private/messages", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session(employeeId) },
      body: JSON.stringify({ message: "开始报销", turnId: `closed-${crypto.randomUUID()}` }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "报销服务暂不可用，请稍后重试。" });
    expect(await prisma.claimDraft.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.reimbursementIntake.count({ where: { employeeId } })).toBe(0);
  } finally {
    if (original === undefined) delete process.env.REIMBURSEMENT_API_URL;
    else process.env.REIMBURSEMENT_API_URL = original;
  }
});

it("uploads an attachment through the Go tools without writing a legacy claim", async () => {
  const employeeId = `conversation-api-${crypto.randomUUID()}`;
  await prisma.employee.create({ data: { id: employeeId, displayName: "员工 A" } });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/v1/claims")) return Response.json({ id: "go-claim-1", version: 1, status: "DRAFT", purpose: "" }, { status: 201 });
    if (url.endsWith("/api/v1/claims/go-claim-1/uploads")) return Response.json({ receiptId: "go-receipt-1", uploadUrl: "http://localhost:9000/bucket/go-receipt-1" }, { status: 201 });
    if (url.endsWith("/api/v1/claims/go-claim-1/receipts")) return Response.json({ receiptId: "go-receipt-1", status: "READY_FOR_OCR" }, { status: 202 });
    if (url === "http://localhost:9000/bucket/go-receipt-1") return new Response(null, { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "receipt.png");
    form.set("turnId", `upload-${crypto.randomUUID()}`);
    const response = await postAttachment(new Request("http://localhost/api/conversations/private/attachments", { method: "POST", headers: { cookie: session(employeeId) }, body: form }));
    expect(response.status).toBe(201);
    expect(calls).toEqual([
      "POST http://127.0.0.1:8088/api/v1/claims",
      "POST http://127.0.0.1:8088/api/v1/claims/go-claim-1/uploads",
      "PUT http://localhost:9000/bucket/go-receipt-1",
      "POST http://127.0.0.1:8088/api/v1/claims/go-claim-1/receipts",
    ]);
    expect(await prisma.claimDraft.count({ where: { employeeId } })).toBe(0);
    const conversation = await prisma.agentConversation.findFirstOrThrow({ where: { employeeId } });
    expect(await prisma.agentToolCall.count({ where: { conversationId: conversation.id } })).toBe(3);
    const replay = await postAttachment(new Request("http://localhost/api/conversations/private/attachments", { method: "POST", headers: { cookie: session(employeeId) }, body: form }));
    expect(replay.status).toBe(201);
    expect(calls).toHaveLength(4);
    expect(await prisma.agentToolCall.count({ where: { conversationId: conversation.id } })).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("answers a private amount query from the signed-in employee's Go claim", async () => {
  const employeeId = `conversation-api-${crypto.randomUUID()}`;
  await prisma.employee.create({ data: { id: employeeId, displayName: "员工 A" } });
  const conversations = new AgentConversationRepository(prisma);
  const conversation = await conversations.getOrCreatePrivate(employeeId);
  await conversations.createIntake({ employeeId, conversationId: conversation.id, claimId: "go-claim-1", pendingFields: [] });
  const originalFetch = globalThis.fetch;
  const originalModelProvider = process.env.MODEL_PROVIDER;
  const originalModelBaseUrl = process.env.MODEL_BASE_URL;
  const originalModelName = process.env.MODEL_NAME;
  const originalModelKey = process.env.MODEL_PROVIDER_API_KEY;
  process.env.MODEL_PROVIDER = "openai-compatible";
  process.env.MODEL_BASE_URL = "http://model.test/v1";
  process.env.MODEL_NAME = "fixture";
  process.env.MODEL_PROVIDER_API_KEY = "fixture-key";
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === "http://model.test/v1/chat/completions") {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0].content);
      const content = system.includes("意图分类器") && !system.includes("会话意图")
        ? { intent: "CLAIM_ACTION" }
        : { action: "READ_RECEIPT_AMOUNT", reply: "模型虚构金额 999 元" };
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    if (url.endsWith("/api/v1/claims/go-claim-1")) return Response.json({ id: "go-claim-1", claimNumber: "BX-001", version: 2, status: "DRAFT", purpose: "出差", requestedAmountCent: 20000, totalAmountCent: 10155, currency: "CNY", receiptCount: 1 });
    if (url.endsWith("/api/v1/claims/go-claim-1/receipts")) return Response.json({ items: [{ id: "receipt-1", claimId: "go-claim-1", filename: "invoice.pdf", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.98, totalAmountCent: 10155 }] });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const response = await postMessage(new Request("http://localhost/api/conversations/private/messages", { method: "POST", headers: { "content-type": "application/json", cookie: session(employeeId) }, body: JSON.stringify({ message: "这张发票多少钱", turnId: `read-${crypto.randomUUID()}` }) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reply).toContain("¥101.55");
    expect(body.reply).not.toContain("999");
    expect(calls).toContain("http://127.0.0.1:8088/api/v1/claims/go-claim-1");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalModelProvider === undefined) delete process.env.MODEL_PROVIDER; else process.env.MODEL_PROVIDER = originalModelProvider;
    if (originalModelBaseUrl === undefined) delete process.env.MODEL_BASE_URL; else process.env.MODEL_BASE_URL = originalModelBaseUrl;
    if (originalModelName === undefined) delete process.env.MODEL_NAME; else process.env.MODEL_NAME = originalModelName;
    if (originalModelKey === undefined) delete process.env.MODEL_PROVIDER_API_KEY; else process.env.MODEL_PROVIDER_API_KEY = originalModelKey;
  }
});
