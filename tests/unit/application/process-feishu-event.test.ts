import { expect, it } from "vitest";

import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";

function fixture(overrides: Partial<ProcessFeishuEventDeps> = {}) {
  const calls = { findEmployee: 0, createClaim: 0, setConversation: 0, runAgent: 0 };
  const deps: ProcessFeishuEventDeps = {
    botOpenId: "ou_bot",
    publicAppUrl: "https://reimbursement.example.test",
    events: {
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-1", senderOpenId: "ou-employee", chatType: "p2p", mentionedOpenIds: [] }),
      findEmployeeByOpenId: async () => {
        calls.findEmployee += 1;
        return { id: "employee-1" };
      },
      getConversation: async () => null,
      setConversation: async () => {
        calls.setConversation += 1;
      },
    },
    client: {
      getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "客户午餐", mentions: [], attachments: [] }),
      downloadResource: async () => ({ bytes: new Uint8Array(), filename: "unused", mimeType: "application/octet-stream" }),
      replyText: async () => undefined,
      replyCard: async () => undefined,
    },
    createClaimDraft: async () => {
      calls.createClaim += 1;
      return { id: `claim-${calls.createClaim}`, employeeId: "employee-1", status: "DRAFT", purpose: null, version: 0 };
    },
    runAgentTurn: async () => {
      calls.runAgent += 1;
      return { reply: "请补充用餐人员。", clarifications: [], proposals: [{ id: "proposal-secret", target: "claim", field: "purpose", displayValue: "客户午餐", reason: "test", status: "PENDING", claimVersion: 0 }] };
    },
    uploadReceipt: async () => ({ id: "receipt-1", claimId: "claim-1", objectKey: "private", originalFilename: "receipt.jpg", contentHash: "hash", mimeType: "image/jpeg", status: "PENDING" }),
    extractReceipt: async () => ({ receiptId: "receipt-1", expenseItemCreated: true, validationIssues: [] }),
    ...overrides,
  };
  return { deps, calls };
}

it("ignores a group message that does not mention the bot before looking up an employee", async () => {
  const { deps, calls } = fixture({
    events: {
      ...fixture().deps.events,
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-1", senderOpenId: "ou-employee", chatType: "group", mentionedOpenIds: ["ou-other"] }),
    },
    client: { ...fixture().deps.client, getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", senderOpenId: "ou-employee", messageType: "text", text: "报销", attachments: [] }) },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toEqual({ kind: "IGNORED" });
  expect(calls.findEmployee).toBe(0);
  expect(calls.createClaim).toBe(0);
});

it("uses durable group metadata instead of the message-query response when enforcing bot mentions", async () => {
  const { deps, calls } = fixture({
    events: {
      ...fixture().deps.events,
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-1", senderOpenId: "ou-employee", chatType: "group", mentionedOpenIds: ["ou-other"] }),
    },
    client: {
      ...fixture().deps.client,
      getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", senderOpenId: "ou-employee", messageType: "text", text: "报销", attachments: [] }),
    },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toEqual({ kind: "IGNORED" });
  expect(calls.findEmployee).toBe(0);
});

it("returns a Web OAuth login link for an unbound employee without creating a claim", async () => {
  const { deps, calls } = fixture({
    events: { ...fixture().deps.events, findEmployeeByOpenId: async () => null },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toEqual({
    kind: "LOGIN_REQUIRED",
    replyText: "请先登录并绑定飞书账号：https://reimbursement.example.test/api/auth/feishu/login",
  });
  expect(calls.createClaim).toBe(0);
  expect(calls.setConversation).toBe(0);
});

it("creates and links a first draft before routing ordinary text to the agent", async () => {
  const { deps, calls } = fixture();

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({
    kind: "AGENT_REPLIED",
    claimId: "claim-1",
    replyText: expect.stringContaining("https://reimbursement.example.test/claims/claim-1"),
  });
  expect(calls.createClaim).toBe(1);
  expect(calls.setConversation).toBe(1);
  expect(calls.runAgent).toBe(1);
});

it("replaces the current conversation binding for the new-claim command", async () => {
  const { deps, calls } = fixture({
    client: { ...fixture().deps.client, getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "新建报销", mentions: [], attachments: [] }) },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "CLAIM_LINKED", claimId: "claim-1" });
  expect(calls.createClaim).toBe(1);
  expect(calls.setConversation).toBe(1);
  expect(calls.runAgent).toBe(0);
});

it("returns the currently linked Web workspace without calling the agent", async () => {
  const { deps, calls } = fixture({
    client: { ...fixture().deps.client, getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "查看当前草稿", mentions: [], attachments: [] }) },
    events: { ...fixture().deps.events, getConversation: async () => ({ claimId: "claim-existing" }) },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toEqual({
    kind: "CLAIM_LINKED",
    claimId: "claim-existing",
    replyText: "当前报销草稿：https://reimbursement.example.test/claims/claim-existing",
  });
  expect(calls.createClaim).toBe(0);
  expect(calls.runAgent).toBe(0);
});

it("keeps agent suggestions on the Web workspace without exposing proposal identifiers or actions", async () => {
  const { deps } = fixture();

  const result = await processFeishuEvent({ eventId: "event-1" }, deps);

  expect(result).toMatchObject({ kind: "AGENT_REPLIED", replyText: expect.stringContaining("请在工作台确认") });
  if (result.kind !== "AGENT_REPLIED") throw new Error("agent reply expected");
  expect(result.replyText).not.toContain("proposal-secret");
  expect(result.replyText).not.toContain("接受");
  expect(result.replyText).not.toContain("提交");
});
