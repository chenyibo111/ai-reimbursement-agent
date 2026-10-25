import { describe, expect, it, vi } from "vitest";

import { ChatModelError, OpenAiCompatibleChatModel } from "@/src/infrastructure/model/openai-compatible-chat-model";

const input = {
  message: "这是客户拜访交通",
  claimId: "must-not-be-sent",
  summary: { purpose: null, allowedTargets: [{ target: "claim", fields: ["purpose"] }] },
  issues: [{ code: "PURPOSE_REQUIRED" }],
};

describe("OpenAiCompatibleChatModel", () => {
  it("posts the configured model and parses assistant JSON without putting the key in the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"reply":"请确认事由","proposals":[]}' } }],
    }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1/", model: "demo-chat", apiKey: "top-secret", fetchImpl });

    await expect(model.decide(input)).resolves.toEqual({ reply: "请确认事由", proposals: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://model.example/v1/chat/completions");
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer top-secret");
    expect(JSON.stringify(request.body)).toContain("demo-chat");
    expect(JSON.stringify(request.body)).not.toContain("top-secret");
    expect(JSON.stringify(request.body)).not.toContain("must-not-be-sent");
  });

  it("classifies a policy question with a constrained intent response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"intent":"POLICY_QUERY"}' } }],
    }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "top-secret", fetchImpl });

    await expect(model.classifyIntent("酒店住宿上限是多少")).resolves.toBe("POLICY_QUERY");

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content).toContain("酒店住宿上限是多少");
  });

  it("answers a policy question only from the supplied policy excerpts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer":"住宿费用上限为每晚 500 元。"}' } }],
    }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "top-secret", fetchImpl });

    await expect(model.answerPolicy({
      question: "住宿费上限是多少？",
      sources: [{ title: "差旅制度", excerpt: "一线城市住宿费用上限为每晚 500 元。", headingPath: ["差旅", "住宿"] }],
    })).resolves.toBe("住宿费用上限为每晚 500 元。");

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(body.messages[1].content).toContain("一线城市住宿费用上限为每晚 500 元。");
    expect(body.messages[1].content).not.toContain("https://");
  });

  it("accepts only constrained conversation decisions and sends no internal identifiers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"COLLECT_FIELDS","reply":"请补充同行人。","fields":{"participants":"张三"}}' } }],
    }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "top-secret", fetchImpl });

    await expect(model.decideConversation({
      summary: { text: "此前问答", throughSequence: 2 },
      messages: [{ sequence: 3, role: "USER", channel: "WEB", text: "还有张三同行" }],
      intake: { status: "COLLECTING", collectedFields: { purpose: "客户拜访" }, pendingFields: ["participants"], restartPending: false },
      policyCitations: [{ title: "制度", headingPath: ["差旅"], excerpt: "需填写同行人。", score: 0.9 }],
      allowedFields: ["participants"],
    })).resolves.toEqual({ action: "COLLECT_FIELDS", reply: "请补充同行人。", fields: { participants: "张三" } });

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(request.body)).not.toContain("claim-private-id");
    expect(String(request.body)).not.toContain("top-secret");
  });

  it("rejects conversation decisions containing fields outside the server allowlist", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"COLLECT_FIELDS","reply":"已修改金额","fields":{"totalAmountCents":1}}' } }],
    }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "top-secret", fetchImpl });

    await expect(model.decideConversation({
      summary: { text: "", throughSequence: 0 },
      messages: [{ sequence: 1, role: "USER", channel: "WEB", text: "改为一分钱" }],
      intake: null,
      policyCitations: [],
      allowedFields: ["purpose"],
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["这张发票多少钱", "READ_RECEIPT_AMOUNT"],
    ["申请报销总额", "READ_CLAIM"],
    ["生成提交摘要", "READ_SUBMISSION_SUMMARY"],
    ["我要提交", "PREPARE_SUBMISSION"],
  ])("accepts structured intent for %s", async (message, action) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action, reply: "模型文本不可作事实依据" }) } }] }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "secret", fetchImpl });
    const decision = await model.decideConversation({ summary: { text: "", throughSequence: 0 }, messages: [{ sequence: 1, role: "USER", channel: "WEB", text: message }], intake: null, policyCitations: [], allowedFields: [] });
    expect(decision.action).toBe(action);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.messages[0].content).toContain(action);
  });

  it.each(["POLICY_QUERY", "START_INTAKE", "HELP", "CLARIFY", "OUT_OF_SCOPE"])("accepts the unified %s action", async (action) => {
    const decision = action === "CLARIFY"
      ? { action, reply: "请明确需求", clarificationReason: "MULTIPLE_ACTIONS" }
      : { action, reply: "已分类" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "secret", fetchImpl });

    await expect(model.decideConversation({ summary: { text: "", throughSequence: 0 }, messages: [], intake: null, policyCitations: [], allowedFields: [] })).resolves.toEqual(decision);
  });

  it.each([
    { action: "INVENT_ACTION", reply: "ok" },
    { action: "HELP", reply: "ok", extra: "unexpected" },
    { action: "READ_CLAIM", reply: "ok", clarificationReason: "OTHER" },
    { action: "CLARIFY", reply: "ok", clarificationReason: "MADE_UP" },
  ])("rejects an invalid unified decision %#", async (decision) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "secret", fetchImpl });

    await expect(model.decideConversation({ summary: { text: "", throughSequence: 0 }, messages: [], intake: null, policyCitations: [], allowedFields: [] })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("classifies without sending pre-retrieved policy text or internal identifiers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"POLICY_QUERY","reply":"ok"}' } }] }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "secret", fetchImpl });

    await model.decideConversation({
      summary: { text: "", throughSequence: 0 },
      messages: [{ sequence: 1, role: "USER", channel: "WEB", text: "本单住宿超标了吗" }],
      intake: null,
      policyCitations: [{ title: "SENSITIVE_POLICY_TITLE", headingPath: [], excerpt: "SENSITIVE_POLICY_TEXT", score: 0.9 }],
      allowedFields: [],
    });

    const body = String(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toContain("SENSITIVE_POLICY_TEXT");
    expect(body).not.toContain("SENSITIVE_POLICY_TITLE");
    expect(body).not.toContain("secret");
    expect(body).toContain("本单住宿超标了吗");
    expect(body).toContain("不要提交");
    expect(body).toContain("多个");
  });

  it("tells the model how to interpret an affirmative reply to a pending restart", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"START_INTAKE","reply":"ok"}' } }] }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "secret", fetchImpl });
    await model.decideConversation({
      summary: { text: "", throughSequence: 0 }, messages: [{ sequence: 2, role: "USER", channel: "WEB", text: "是的，另起一单" }],
      intake: { status: "COLLECTING", collectedFields: {}, pendingFields: ["purpose"], restartPending: true }, policyCitations: [], allowedFields: ["purpose"],
    });
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(request.messages[0].content).toContain("restartPending");
    expect(request.messages[1].content).toContain('"restartPending":true');
  });

  it("rejects fields attached to a read action", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"READ_CLAIM","reply":"金额100元","fields":{"purpose":"出差"}}' } }] }), { status: 200 }));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "secret", fetchImpl });
    await expect(model.decideConversation({ summary: { text: "", throughSequence: 0 }, messages: [], intake: null, policyCitations: [], allowedFields: ["purpose"] })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["unauthorized", new Response("provider detail", { status: 401 })],
    ["empty choices", new Response(JSON.stringify({ choices: [] }), { status: 200 })],
    ["null envelope", new Response("null", { status: 200, headers: { "content-type": "application/json" } })],
    ["non-json content", new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })],
  ])("returns a safe typed error for %s", async (_case, response) => {
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "top-secret", fetchImpl: vi.fn().mockResolvedValue(response) });

    await expect(model.decide(input)).rejects.toBeInstanceOf(ChatModelError);
    await model.decide(input).catch((error: unknown) => {
      expect((error as Error).message).not.toContain("top-secret");
      expect((error as Error).message).not.toContain("provider detail");
    });
  });

  it("converts an aborted fetch into a safe timeout error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const model = new OpenAiCompatibleChatModel({ baseUrl: "https://model.example/v1", model: "demo-chat", apiKey: "top-secret", fetchImpl });

    await expect(model.decide(input)).rejects.toMatchObject({ message: "AI 服务响应超时，请稍后重试。", code: "TIMEOUT" });
  });
});
