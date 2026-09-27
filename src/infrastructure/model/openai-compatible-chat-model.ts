import type { AgentIntent, ChatModel, ChatModelInput, PolicyAnswerInput } from "@/src/infrastructure/model/chat-model";
import type { ConversationContext } from "@/src/application/build-conversation-context";
import { isConversationCollectedFieldName } from "@/src/domain/agent-conversation";
import { z } from "zod";

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
    return this.complete([
      {
        role: "system",
        content: "你是报销澄清助手。只返回一个 JSON 对象，格式为 {reply: string, proposals: array}。proposals 只可以是服务端提供的候选目标和字段；你只能提出建议，不能声称已更新、已提交或已确认。信息不足时，proposals 为空并在 reply 中提出澄清问题。",
      },
      {
        role: "user",
        content: JSON.stringify({ message: input.message, summary: input.summary, issues: input.issues }),
      },
    ]);
  }

  async classifyIntent(message: string): Promise<AgentIntent> {
    const result = await this.complete([
      {
        role: "system",
        content: "你是报销对话意图分类器。只返回 JSON：{intent: \"POLICY_QUERY\" | \"CLAIM_ACTION\" | \"OTHER\"}。POLICY_QUERY 仅用于咨询公司报销制度、可否报销、额度上限、票据要求或标准；CLAIM_ACTION 用于创建、上传、修改、补充或提交当前报销单；其他为 OTHER。",
      },
      { role: "user", content: JSON.stringify({ message }) },
    ]);
    if (!result || typeof result !== "object" || Array.isArray(result) || !["POLICY_QUERY", "CLAIM_ACTION", "OTHER"].includes(String((result as { intent?: unknown }).intent))) {
      throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    }
    return (result as { intent: AgentIntent }).intent;
  }

  async answerPolicy(input: PolicyAnswerInput): Promise<string> {
    const result = await this.complete([
      {
        role: "system",
        content: "你是企业报销制度问答助手。只依据用户提供的政策片段回答问题，不得编造金额、条件、例外、流程或制度外规则。片段不足以回答时，明确说明“已同步制度片段未包含该信息”。回答要简洁、直接，不要输出链接、引用标题、Markdown 或 JSON 以外的内容。只返回 JSON：{answer: string}。",
      },
      {
        role: "user",
        content: JSON.stringify({ question: input.question, sources: input.sources }),
      },
    ]);
    const answer = result && typeof result === "object" && !Array.isArray(result)
      ? (result as { answer?: unknown }).answer
      : undefined;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    }
    return answer.trim().slice(0, 1_000);
  }

  async decideConversation(input: ConversationContext): Promise<import("@/src/infrastructure/model/chat-model").ConversationDecision> {
    const result = await this.complete([
      {
        role: "system",
        content: "你是受控的报销会话助手。只返回 JSON：{action: \"ANSWER\" | \"START_INTAKE\" | \"COLLECT_FIELDS\" | \"REQUEST_SUBMISSION\", reply: string, fields?: Record<string,string>}。你不能创建任意草稿、不能提交、不能声称已写入数据。只有服务端提供的 allowedFields 能出现在 fields；没有可写字段时不要返回 fields。政策结论只能依据 policyCitations。",
      },
      { role: "user", content: JSON.stringify(input) },
    ]);
    return parseConversationDecision(result, input.allowedFields);
  }

  private async complete(messages: Array<{ role: "system" | "user"; content: string }>): Promise<unknown> {
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
          messages,
        }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ChatModelError("AI 服务响应超时，请稍后重试。", "TIMEOUT");
      }
      throw new ChatModelError("AI 服务暂不可用，请稍后重试。", "UNAVAILABLE");
    }

    if (!response.ok) throw new ChatModelError("AI 服务暂不可用，请稍后重试。", "UNAVAILABLE");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    }

    const content = isChatCompletionEnvelope(payload) ? payload.choices?.[0]?.message?.content : undefined;
    if (typeof content !== "string") throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
    }
  }
}

const conversationDecisionSchema = z.object({
  action: z.enum(["ANSWER", "START_INTAKE", "COLLECT_FIELDS", "REQUEST_SUBMISSION"]),
  reply: z.string().trim().min(1).max(1_000),
  fields: z.record(z.string(), z.string().trim().min(1).max(1_000)).optional(),
}).strict();

function parseConversationDecision(
  value: unknown,
  allowedFields: readonly string[],
): import("@/src/infrastructure/model/chat-model").ConversationDecision {
  const parsed = conversationDecisionSchema.safeParse(value);
  if (!parsed.success) throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  const fields = parsed.data.fields;
  if (fields && (parsed.data.action !== "COLLECT_FIELDS" || Object.keys(fields).some((field) => !allowedFields.includes(field) || !isConversationCollectedFieldName(field)))) {
    throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  }
  return fields
    ? { action: parsed.data.action, reply: parsed.data.reply, fields }
    : { action: parsed.data.action, reply: parsed.data.reply };
}

function isChatCompletionEnvelope(payload: unknown): payload is { choices?: Array<{ message?: { content?: unknown } }> } {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}
