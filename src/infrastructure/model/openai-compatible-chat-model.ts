import type { ChatModel, ChatModelInput } from "@/src/infrastructure/model/chat-model";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type OpenAiCompatibleChatModelOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: Fetch;
};

export class ChatModelError extends Error {
  constructor(
    message: string,
    readonly code: "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE",
  ) {
    super(message);
    this.name = "ChatModelError";
  }
}

export class OpenAiCompatibleChatModel implements ChatModel {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: OpenAiCompatibleChatModelOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide(input: ChatModelInput): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "你是报销澄清助手。只返回一个 JSON 对象，格式为 {reply: string, proposals: array}。proposals 只可以是服务端提供的候选目标和字段；你只能提出建议，不能声称已更新、已提交或已确认。信息不足时，proposals 为空并在 reply 中提出澄清问题。",
            },
            {
              role: "user",
              content: JSON.stringify({
                message: input.message,
                summary: input.summary,
                issues: input.issues,
              }),
            },
          ],
        }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ChatModelError("AI 服务响应超时，请稍后重试。", "TIMEOUT");
      }
      throw new ChatModelError("AI 服务暂不可用，请稍后重试。", "UNAVAILABLE");
    }

    if (!response.ok) throw new ChatModelError("AI 服务暂不可用，请稍后重试。", "UNAVAILABLE");

    let payload: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    } catch {
      throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    }
  }
}
