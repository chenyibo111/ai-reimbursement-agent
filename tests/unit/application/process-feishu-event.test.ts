import { expect, it } from "vitest";

import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";

function fixture(overrides: Partial<ProcessFeishuEventDeps> = {}) {
  const calls = { findEmployee: 0, private: 0, group: 0, deliveryTargets: [] as Array<{ conversationId: string; chatId: string }>, turn: [] as Array<Record<string, unknown>>, download: 0 };
  const deps: ProcessFeishuEventDeps = {
    botOpenId: "ou-bot",
    publicAppUrl: "https://reimbursement.example.test",
    events: {
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-1", senderOpenId: "ou-employee", chatType: "p2p", mentionedOpenIds: [] }),
      findEmployeeByOpenId: async () => {
        calls.findEmployee += 1;
        return { id: "employee-1" };
      },
    },
    conversations: {
      getOrCreatePrivate: async () => {
        calls.private += 1;
        return { id: "private-employee-1" };
      },
      getOrCreateGroup: async () => {
        calls.group += 1;
        return { id: "group-employee-1-oc-1" };
      },
      recordFeishuDeliveryTarget: async (input) => { calls.deliveryTargets.push(input); },
    },
    client: {
      getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "住宿报销规则是什么", mentions: [], attachments: [] }),
      downloadResource: async () => {
        calls.download += 1;
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), filename: "receipt.jpg", mimeType: "image/jpeg" };
      },
      sendText: async () => undefined,
      replyText: async () => undefined,
      replyCard: async () => undefined,
    },
    runConversationTurn: async (input) => {
      calls.turn.push(input);
      return {
        reply: "住宿费用上限为每晚 500 元。",
        citations: [{ id: "chunk-1", title: "差旅制度", url: "https://acme.feishu.cn/docx/secret", excerpt: "一线城市住宿上限 500 元。", headingPath: ["住宿"], score: 0.91 }],
        intake: null,
      };
    },
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
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toEqual({ kind: "IGNORED" });
  expect(calls.findEmployee).toBe(0);
  expect(calls.turn).toHaveLength(0);
});

it("returns a Web OAuth login link for an unbound employee without creating a conversation", async () => {
  const { deps, calls } = fixture({
    events: { ...fixture().deps.events, findEmployeeByOpenId: async () => null },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toEqual({
    kind: "LOGIN_REQUIRED",
    replyText: "请先登录并绑定飞书账号：https://reimbursement.example.test/api/auth/feishu/login",
  });
  expect(calls.private).toBe(0);
  expect(calls.group).toBe(0);
});

it("routes private policy questions into the shared private conversation without creating a claim", async () => {
  const { deps, calls } = fixture();

  const result = await processFeishuEvent({ eventId: "event-1" }, deps);

  expect(result).toMatchObject({ kind: "AGENT_REPLIED", claimId: null });
  expect(calls.private).toBe(1);
  expect(calls.deliveryTargets).toEqual([{ conversationId: "private-employee-1", chatId: "oc-1" }]);
  expect(calls.turn).toEqual([expect.objectContaining({ conversationId: "private-employee-1", channelMessageId: "om-1", channel: "FEISHU", message: "住宿报销规则是什么" })]);
  if (result.kind !== "AGENT_REPLIED") throw new Error("agent reply expected");
  expect(result.replyText).toContain("政策依据：差旅制度（住宿）");
  expect(result.replyText).toContain("证据摘录：一线城市住宿上限 500 元。");
  expect(result.replyText).not.toContain("https://acme.feishu.cn/docx/secret");
  expect(result.replyText).toContain("/claims");
});

it("uses a per-employee group conversation only for mentioned group messages", async () => {
  const { deps, calls } = fixture({
    events: {
      ...fixture().deps.events,
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-team", senderOpenId: "ou-employee", chatType: "group", mentionedOpenIds: ["ou-bot"] }),
    },
    client: { ...fixture().deps.client, getMessage: async () => ({ messageId: "om-1", chatId: "oc-team", chatType: "group", senderOpenId: "ou-employee", messageType: "text", text: "@机器人 报销政策", mentions: [], attachments: [] }) },
    conversations: {
      getOrCreatePrivate: fixture().deps.conversations.getOrCreatePrivate,
      recordFeishuDeliveryTarget: fixture().deps.conversations.recordFeishuDeliveryTarget,
      getOrCreateGroup: async (employeeId, chatId) => {
        calls.group += 1;
        expect([employeeId, chatId]).toEqual(["employee-1", "oc-team"]);
        return { id: "group-employee-1-oc-team" };
      },
    },
  });

  await processFeishuEvent({ eventId: "event-1" }, deps);
  expect(calls.private).toBe(0);
  expect(calls.group).toBe(1);
  expect(calls.turn[0]).toMatchObject({ conversationId: "group-employee-1-oc-team" });
});

it("downloads an attachment and delegates draft creation and extraction to the shared conversation turn", async () => {
  const { deps, calls } = fixture({
    client: {
      ...fixture().deps.client,
      getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "image", text: "", mentions: [], attachments: [{ fileKey: "file-1", resourceType: "image", filename: "receipt.jpg" }] }),
      downloadResource: async () => {
        calls.download += 1;
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), filename: "receipt.jpg", mimeType: "image/jpeg" };
      },
    },
    runConversationTurn: async (input) => {
      calls.turn.push(input);
      return { reply: "票据已上传并进入识别流程。", citations: [], intake: { id: "intake-1", employeeId: "employee-1", conversationId: "private-employee-1", status: "COLLECTING", claimId: "claim-1", collectedFields: {}, pendingFields: ["purpose"], submissionToken: null } };
    },
  });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "AGENT_REPLIED", claimId: "claim-1", replyText: expect.stringContaining("/claims/claim-1") });
  expect(calls.download).toBe(1);
  expect(calls.turn[0]).toMatchObject({ message: "上传票据", attachment: { filename: "receipt.jpg", mimeType: "image/jpeg" } });
});

it("maps the legacy new-claim command to explicit intake start instead of immediately creating a claim", async () => {
  const { deps, calls } = fixture({
    client: { ...fixture().deps.client, getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "新建报销", mentions: [], attachments: [] }) },
  });

  await processFeishuEvent({ eventId: "event-1" }, deps);
  expect(calls.turn[0]).toMatchObject({ message: "开始报销" });
});
