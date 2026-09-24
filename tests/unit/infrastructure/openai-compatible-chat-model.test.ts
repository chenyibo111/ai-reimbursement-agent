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
