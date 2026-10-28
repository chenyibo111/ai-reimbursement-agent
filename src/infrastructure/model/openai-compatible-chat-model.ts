import type { AgentIntent, ChatModel, ChatModelInput, PolicyAnswerInput } from "@/src/infrastructure/model/chat-model";
import type { ConversationContext } from "@/src/application/build-conversation-context";
import { z } from "zod";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type OpenAiCompatibleChatModelOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: Fetch;
};

const conversationIntentBoundary = "补充意图边界：问发票 OCR 金额是否读出、识别金额是多少或价税合计，使用 READ_RECEIPT_AMOUNT；仅问 OCR 任务是否完成、识别进度或人工复核状态，使用 READ_CLAIM_PROGRESS。员工明确要求进入提交流程、开始提交确认或发起提交，使用 PREPARE_SUBMISSION；仅问能不能提交、还缺什么或需要满足什么条件，使用 READ_SUBMISSION_SUMMARY。明确请求删除票据时使用 DELETE_RECEIPT，即使尚缺单据选择或票据序号也不要猜测，服务端会要求补充；仅仅提及票据而未明确删除意图时再澄清。DELETE_RECEIPT 的 claimNumber 只提取员工本条消息明确提供的完整单号，不要重复助手历史中已选草稿的单号；票据序号只提取员工明确说出的序号。最终删除和最终提交均由服务端另行确认。";

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
        content: "你是企业报销制度问答助手。sources 是服务端检索出的完整章节正文，不是文档全文。只依据这些章节回答，不得编造金额、条件、例外、流程或制度外规则；同一章节中适用的不同城市档位和例外应一起说明。若章节没有包含问题所需信息，明确说明“已同步制度章节未包含该信息”，不要推断整份制度没有规定。回答简洁、直接，不要输出链接、引用标题或 Markdown。只返回 JSON：{answer: string}。",
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
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content: "你是受控的报销会话意图分类器，只分类，不直接办理。只返回 JSON：{action: \"POLICY_QUERY\" | \"START_INTAKE\" | \"COLLECT_FIELDS\" | \"LIST_CLAIMS\" | \"SEARCH_CLAIMS\" | \"NEXT_CLAIMS_PAGE\" | \"SELECT_EDIT_CLAIM\" | \"DELETE_RECEIPT\" | \"DELETE_DRAFT\" | \"READ_CLAIM\" | \"READ_RECEIPT_AMOUNT\" | \"READ_SUBMISSION_SUMMARY\" | \"READ_CLAIM_PROGRESS\" | \"PREPARE_SUBMISSION\" | \"HELP\" | \"CLARIFY\" | \"OUT_OF_SCOPE\", reply: string, fields?: {purpose?:string,expenseCategory?:string,participants?:string[],projectCode?:string}, claimNumber?:string, claimOrdinal?:number, receiptOrdinal?:number, targetReference?:\"CURRENT_INTAKE\", search?:{status?:\"DRAFT\"|\"SUBMITTED\",period?:\"THIS_MONTH\"|\"LAST_MONTH\",createdFrom?:string,createdBefore?:string,purposeContains?:string,expenseCategory?:string,minRequestedAmountCent?:number,maxRequestedAmountCent?:number,sort?:\"created_desc\"|\"created_asc\"|\"amount_desc\"|\"amount_asc\",requestedCount?:number,countOnly?:boolean}, clarificationReason?: \"POLICY_OR_CLAIM\" | \"START_OR_HELP\" | \"MULTIPLE_ACTIONS\" | \"UNCLEAR_REFERENCE\" | \"OTHER\"}。messages 按最新到最旧排列，messages[0] 是最新一条员工消息；历史只用于消解指代。问公司制度、规则、上限用 POLICY_QUERY；简单问最近有哪些报销单用 LIST_CLAIMS；带条件、日期、数量、排序或问总数用 SEARCH_CLAIMS，search 只写员工明确要求的条件，不添加员工 ID，查询总数用 countOnly:true。上月用 period:LAST_MONTH，日期由服务端换算；下一页用 NEXT_CLAIMS_PAGE；查看当前页第二张用 READ_CLAIM 加 claimOrdinal:2，序号必须来自当前页。明确编辑完整单号或当前页某一张时用 SELECT_EDIT_CLAIM 加 claimNumber 或 claimOrdinal；只读查询不会自动授权编辑。明确要求删除选中草稿的票据时用 DELETE_RECEIPT；只有员工明确说出序号才设置 receiptOrdinal，文件名不能当成唯一标识，最终删除必须另行确认。明确要求删除本人草稿时用 DELETE_DRAFT，可提取完整 claimNumber 或当前查询页的 claimOrdinal；仅查看不会授权删除，不能自己生成确认动作。只读单据与当前办理草稿不同时，含糊的“改这张”须用 CLARIFY；选中可编辑草稿后，补报销事由等字段用 COLLECT_FIELDS，默认写入该草稿；只有明确说当前新建办理的草稿才给 COLLECT_FIELDS 或 PREPARE_SUBMISSION 加 targetReference:CURRENT_INTAKE。问当前单据状态、单号、事由、申请报销总额等已有字段用 READ_CLAIM；问本单票据价税合计用 READ_RECEIPT_AMOUNT；问本单是否超标准、能否提交、提交前还缺什么、需要满足什么条件用只读的 READ_SUBMISSION_SUMMARY。问单据进度、OCR、人工复核或提交后处理到哪一步用 READ_CLAIM_PROGRESS；该动作只读，不推断审批或付款。只有员工明确请求发起提交准备、生成待确认的提交摘要时才用 PREPARE_SUBMISSION；若员工明确指定要提交的完整报销单号或当前查询页序号，可同时返回 claimNumber 或 claimOrdinal；询问能不能提交、不要提交、条件式或否定式表达绝不能用 PREPARE_SUBMISSION，更不能当成最终确认。新建一笔报销用 START_INTAKE；如何新建用 HELP。若 intake.restartPending 为 true，且员工明确同意另起一单，也用 START_INTAKE；含糊回答用 CLARIFY，不自行确认。多个相互冲突的动作或确实无法确定指代时用 CLARIFY；单一明确动作不要过度澄清。超出报销范围用 OUT_OF_SCOPE。你不生成金额、权限或状态结论，也不声称已写入或提交。读取时若明确提供报销单号，将其提取到 claimNumber；参与人员必须是明确的人名数组，金额、币种、备注只能在 Web 修改；员工明确请求在对话中修改这些字段时用 COLLECT_FIELDS 且不带 fields，由服务端返回当前目标工作台入口。只有 allowedFields 能出现在 COLLECT_FIELDS 的 fields；其他动作不得带 fields。clarificationReason 仅用于 CLARIFY。",
      },
      { role: "user", content: JSON.stringify({ summary: input.summary, messages: input.messages, intake: input.intake, allowedFields: input.allowedFields }) },
    ];
    messages[0].content += conversationIntentBoundary;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.complete(messages);
        return parseConversationDecision(result, input.allowedFields);
      } catch (error) {
        if (!(error instanceof ChatModelError) || error.code !== "INVALID_RESPONSE" || attempt === 1) throw error;
        messages[0].content += "请重新分类。上一次响应未通过格式或字段校验；只返回严格合法的 JSON 对象，只使用当前 action 允许的字段，不附加推测的目标或参数。";
      }
    }
    throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
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
      if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
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

const boundedField = z.string().trim().min(1).refine((value) => Array.from(value).length <= 200);
const participant = z.string().trim().min(1).refine((value) => Array.from(value).length <= 80);
const conversationDecisionSchema = z.object({
  action: z.enum(["POLICY_QUERY", "START_INTAKE", "COLLECT_FIELDS", "LIST_CLAIMS", "SEARCH_CLAIMS", "NEXT_CLAIMS_PAGE", "SELECT_EDIT_CLAIM", "DELETE_RECEIPT", "DELETE_DRAFT", "READ_CLAIM", "READ_RECEIPT_AMOUNT", "READ_SUBMISSION_SUMMARY", "READ_CLAIM_PROGRESS", "PREPARE_SUBMISSION", "HELP", "CLARIFY", "OUT_OF_SCOPE"]),
  reply: z.string().trim().min(1).max(1_000),
  fields: z.object({ purpose: boundedField.optional(), expenseCategory: boundedField.optional(), participants: z.array(participant).min(1).max(20).refine((values) => new Set(values).size === values.length).optional(), projectCode: boundedField.optional() }).strict().optional(),
  claimNumber: z.string().trim().optional(),
  claimOrdinal: z.number().int().min(1).max(10).optional(),
  receiptOrdinal: z.number().int().min(1).max(100).optional(),
  targetReference: z.enum(["CURRENT_INTAKE"]).optional(),
  search: z.object({
    status: z.enum(["DRAFT", "SUBMITTED"]).optional(),
    period: z.enum(["THIS_MONTH", "LAST_MONTH"]).optional(),
    createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    createdBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    purposeContains: z.string().max(200).optional(),
    expenseCategory: z.string().max(200).optional(),
    minRequestedAmountCent: z.number().int().nonnegative().optional(),
    maxRequestedAmountCent: z.number().int().nonnegative().optional(),
    sort: z.enum(["created_desc", "created_asc", "amount_desc", "amount_asc"]).optional(),
    requestedCount: z.number().int().min(1).max(100).optional(),
    countOnly: z.boolean().optional(),
  }).strict().optional(),
  clarificationReason: z.enum(["POLICY_OR_CLAIM", "START_OR_HELP", "MULTIPLE_ACTIONS", "UNCLEAR_REFERENCE", "OTHER"]).optional(),
}).strict();

function parseConversationDecision(
  value: unknown,
  allowedFields: readonly string[],
): import("@/src/infrastructure/model/chat-model").ConversationDecision {
  const parsed = conversationDecisionSchema.safeParse(value);
  if (!parsed.success) throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  const fields = parsed.data.fields;
  if (fields && (parsed.data.action !== "COLLECT_FIELDS" || Object.keys(fields).length === 0 || Object.keys(fields).some((field) => !allowedFields.includes(field)))) {
    throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  }
  const claimNumber = parsed.data.claimNumber?.toUpperCase();
  if (claimNumber && (!/^BX[0-9]{8}-[0-9]{4,}$/.test(claimNumber) || !["READ_CLAIM", "READ_RECEIPT_AMOUNT", "READ_SUBMISSION_SUMMARY", "READ_CLAIM_PROGRESS", "SELECT_EDIT_CLAIM", "DELETE_RECEIPT", "DELETE_DRAFT", "PREPARE_SUBMISSION"].includes(parsed.data.action))) {
    throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  }
  if (parsed.data.search && parsed.data.action !== "SEARCH_CLAIMS") throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  if (parsed.data.claimOrdinal && (!["READ_CLAIM", "READ_CLAIM_PROGRESS", "SELECT_EDIT_CLAIM", "DELETE_DRAFT", "PREPARE_SUBMISSION"].includes(parsed.data.action) || Boolean(claimNumber))) throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  if (parsed.data.receiptOrdinal && parsed.data.action !== "DELETE_RECEIPT") throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  if (parsed.data.targetReference && !["COLLECT_FIELDS", "PREPARE_SUBMISSION"].includes(parsed.data.action)) throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  if (parsed.data.clarificationReason && parsed.data.action !== "CLARIFY") {
    throw new ChatModelError("AI 返回内容无法识别，请稍后重试。", "INVALID_RESPONSE");
  }
  return { action: parsed.data.action, reply: parsed.data.reply, ...(fields ? { fields } : {}), ...(claimNumber ? { claimNumber } : {}), ...(parsed.data.claimOrdinal ? { claimOrdinal: parsed.data.claimOrdinal } : {}), ...(parsed.data.receiptOrdinal ? { receiptOrdinal: parsed.data.receiptOrdinal } : {}), ...(parsed.data.search ? { search: parsed.data.search } : {}), ...(parsed.data.targetReference ? { targetReference: parsed.data.targetReference } : {}), ...(parsed.data.clarificationReason ? { clarificationReason: parsed.data.clarificationReason } : {}) };
}

function isChatCompletionEnvelope(payload: unknown): payload is { choices?: Array<{ message?: { content?: unknown } }> } {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}
