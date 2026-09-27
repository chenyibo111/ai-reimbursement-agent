import { expect, it, vi } from "vitest";

import { loadAgentConversation, sendAgentConversationMessage } from "@/src/ui/use-agent-conversation";

it("loads only the persisted employee-private conversation", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    conversation: { id: "private-1", kind: "PRIVATE", lastActiveAt: "2026-09-27T12:00:00.000Z" },
    messages: [{ id: "message-1", sequence: 1, role: "ASSISTANT", channel: "FEISHU", text: "已保存的政策回答", citations: [], result: null, createdAt: "2026-09-27T12:00:00.000Z" }],
    intake: null,
  }), { status: 200 }));

  await expect(loadAgentConversation(fetchImpl)).resolves.toMatchObject({
    conversation: { id: "private-1", kind: "PRIVATE" },
    messages: [{ text: "已保存的政策回答", channel: "FEISHU" }],
  });
  expect(fetchImpl).toHaveBeenCalledWith("/api/conversations/private", expect.objectContaining({ signal: undefined }));
});

it("sends a policy-only message without assigning a claim ID", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    reply: "住宿上限为每晚 500 元。",
    citations: [{ id: "chunk-1", title: "差旅制度", url: "https://example.test/policy", excerpt: "一线城市住宿上限 500 元。", headingPath: ["住宿"], score: 0.92 }],
    intake: null,
  }), { status: 200 }));

  await expect(sendAgentConversationMessage({ message: "住宿上限是多少", fetchImpl })).resolves.toMatchObject({
    reply: "住宿上限为每晚 500 元。",
    intake: null,
  });
  expect(fetchImpl).toHaveBeenCalledWith("/api/conversations/private/messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "住宿上限是多少" }) }));
});

it("sends the exact confirmation command through the ordinary message endpoint", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reply: "报销单已提交。", citations: [], intake: { id: "intake-1", status: "SUBMITTED", claimId: "claim-1" } }), { status: 200 }));

  await sendAgentConversationMessage({ message: "确认提交", fetchImpl });

  expect(fetchImpl).toHaveBeenCalledWith("/api/conversations/private/messages", expect.objectContaining({ body: JSON.stringify({ message: "确认提交" }) }));
});
