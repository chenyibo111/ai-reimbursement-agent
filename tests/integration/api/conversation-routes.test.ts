import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GET as getPrivateConversation } from "@/app/api/conversations/private/route";
import { POST as postMessage } from "@/app/api/conversations/private/messages/route";
import { POST as postAttachment } from "@/app/api/conversations/private/attachments/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.MODEL_PROVIDER = "fixture";
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
    body: JSON.stringify({ message: "报销制度是什么" }),
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
    body: JSON.stringify({ message: "开始报销" }),
  }));

  expect(response.status).toBe(401);
  await expect(prisma.agentConversation.count()).resolves.toBe(0);
});

it("rejects an unsafe attachment before creating an agent claim or Intake", async () => {
  await prisma.employee.create({ data: { id: "conversation-api-a", displayName: "员工 A" } });
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], { type: "application/pdf" }), "unsafe.pdf");

  const response = await postAttachment(new Request("http://localhost/api/conversations/private/attachments", {
    method: "POST",
    headers: { cookie: session("conversation-api-a") },
    body: form,
  }));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "file signature does not match declared type" });
  expect(await prisma.claimDraft.count({ where: { employeeId: "conversation-api-a" } })).toBe(0);
  expect(await prisma.reimbursementIntake.count({ where: { employeeId: "conversation-api-a" } })).toBe(0);
});
