# 飞书与 Web 同权报销查询及确认提交 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让员工在飞书私聊和 Web Agent 查询本人当前报销单/票据金额、获取只读摘要，并通过明确确认提交；所有金额和权限结论来自 Go。

**Architecture:** 保留结构化模型意图和既有 Go Tool Gateway。会话层只决定动作，工具层以当前 Intake 的 `claimId` 和可信员工 ID 读取 Go；事实性回复由服务端格式化。只读摘要、申请确认令牌和最终提交分离，Go 负责最终归属、校验、版本和幂等。

**Tech Stack:** TypeScript、Next.js、Vitest、Go HTTP API、Prisma（仅会话/身份/工具账本）、飞书长连接 Worker。

**Spec:** `docs/superpowers/specs/2026-10-24-feishu-claim-query-and-submit-design.md`

**实施状态（2026-10-24）：** Task 1–5 的编码、红灯/绿灯测试和提交已完成。独立复核发现的待复核 OCR 候选金额、部分票据小计和同名票据区分问题已补回归测试并修复。自动化验证通过；下方“手工验收”仍需在实际飞书私聊与 Web 环境执行，不能以自动测试替代。

## Global Constraints

- Go 是唯一报销事实源；不得恢复 Node/Prisma 报销领域读写兜底，不新增 MCP 或模型供应商。
- 金额单位为分；展示时区分发票价税合计、票据合计与申请报销总额；本期币种仅 CNY。
- 当前单据仅是当前会话 Intake 绑定的 `claimId`；不自动挑最新草稿，也不依据模型输出的 ID 查询。
- 飞书和 Web 映射同一员工 ID，Go 检查活动状态与数据归属；群聊不回显金额、摘要或提交结果，也不提交。
- 模型不能生成金额、权限、单据状态等业务事实；`ANSWER` 不可原样输出事实性断言。
- “生成提交摘要”只读且不生成令牌；“准备提交”经 Go 校验成功才生成确认令牌；“确认提交”只在有效准备后执行。
- 单据变更、过期令牌、重投消息或 Go 故障均不得导致错误或重复提交。

## Review Focus

- 多张票据时“这张发票多少钱”指代不明：回复可区分的票据列表/请求指定，不任选一张；Task 3。
- OCR 金额 `null`、票据复核中、申请额未填：逐项显示未知，不把零、OCR 合计或历史消息当现值；Task 3。
- 模型把“无权限/金额为 X”放在 `ANSWER.reply`：服务端不得直接输出该断言；Task 2。
- 飞书群聊 `@机器人` 查询金额或发送“确认提交”：不调用敏感工具、不向群里回显结果；Task 5。
- Web 修改单据后飞书使用旧确认令牌、飞书重投同一消息：不得提交旧版本或重复单据；Task 4。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `services/agent/src/ports/reimbursement-port.ts` | Agent 从 Go 读取的单据、票据和校验数据契约。 |
| `services/agent/src/tool-gateway/conversation-reimbursement.ts` | 会话只读查询和准备提交映射到既有工具。 |
| `src/infrastructure/model/chat-model.ts`、`openai-compatible-chat-model.ts` | 结构化动作集合及严格解析。 |
| `src/application/format-claim-facts.ts` | 根据 Go 返回值生成金额、摘要、阻断项回复；不接受模型事实文本。 |
| `src/application/run-conversation-turn.ts` | 当前 Intake、只读动作、准备/确认状态机。 |
| Web 消息路由与飞书 Worker | 为同一会话动作注入可信员工上下文和 Go 工具。 |
| `src/application/process-feishu-event.ts` | 群聊敏感操作保护。 |
| 单元、集成与 Go 授权测试 | 同义问法、归属、失败状态、版本与幂等。 |

### Task 1: 补齐 Go 工具读取契约

**Files:**
- Modify: `services/agent/src/ports/reimbursement-port.ts`
- Modify: `services/agent/src/tool-gateway/conversation-reimbursement.ts`
- Modify: `services/agent/src/tool-gateway/conversation-reimbursement.test.ts`
- Modify: `services/agent/src/ports/reimbursement-port.test.ts`

**Interfaces:**
- Consumes: 既有 `get_claim_workbench`、`get_claim_validation`、`request_submission_confirmation`。
- Produces: `readWorkbench(context: ConversationReimbursementContext, claimId: string): Promise<{ claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }>`；`readValidation(context, claimId): Promise<ValidationSnapshot>`；`prepareSubmission(context, claimId): Promise<{ confirmationToken: string; claimId: string; claimVersion: number; workbench: { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] } }>`。
- `ClaimSnapshot` 补 `claimNumber`、`totalAmountCent: number | null`、`currency: "CNY"`；`ReceiptSnapshot` 补 `totalAmountCent: number | null`。保留现有字段，并将 Go 可为 `null` 的金额按原值传递。

- [x] **Step 1: 写失败测试**：`readWorkbench` 返回两张票据的不同 `totalAmountCent`；`readValidation` 只调用只读工具；`prepareSubmission` 才调用确认工具，并携带工作台读取到的版本；金额 `null` 不转零。
- [x] **Step 2: 运行失败测试**：`npm --prefix services/agent test -- src/tool-gateway/conversation-reimbursement.test.ts src/ports/reimbursement-port.test.ts`；预期新方法/字段测试失败。
- [x] **Step 3: 实现**：扩展端口数据契约和 `createConversationReimbursementTools` 返回的三个方法；复用现有工具网关、员工上下文与幂等 ID，不新增直接 HTTP 或 Prisma 路径。
- [x] **Step 4: 验证**：同 Step 2 命令，预期全部通过。
- [x] **Step 5: 提交**：仅提交本任务四个文件，提交信息 `feat: expose claim and receipt facts to agent`。

### Task 2: 扩展结构化意图并封住自由事实回复

**Files:**
- Modify: `src/infrastructure/model/chat-model.ts`
- Modify: `src/infrastructure/model/openai-compatible-chat-model.ts`
- Modify: `src/application/run-conversation-turn.ts`
- Modify: `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`
- Modify: `tests/unit/application/run-conversation-turn.test.ts`

**Interfaces:**
- Consumes: 现有 `ConversationContext` 与 `allowedFields`。
- Produces: `ConversationDecision.action` 增加 `READ_CLAIM | READ_RECEIPT_AMOUNT | READ_SUBMISSION_SUMMARY | PREPARE_SUBMISSION`；暂保留旧 `REQUEST_SUBMISSION` 以使已有会话测试可运行，Task 4 再迁移并移除。`fields` 仍只允许 `COLLECT_FIELDS` 且必须在 `allowedFields` 中。

- [x] **Step 1: 写失败测试**：模拟模型对“这张发票多少钱”“申请报销总额”“生成提交摘要”“我要提交”返回四个结构化动作，断言 schema 接受且 prompt 说明各意图；非法动作/越界 `fields` 被拒；模型以 `ANSWER.reply` 虚构金额或“没有权限”时 `runConversationTurn` 返回固定的非事实性引导，不直接发送模型原文；`COLLECT_FIELDS` 的成功回复也以服务端已保存值为准。真实模型的同义问法另在手工验收中验证。
- [x] **Step 2: 运行失败测试**：`npm test -- tests/unit/infrastructure/openai-compatible-chat-model.test.ts tests/unit/application/run-conversation-turn.test.ts`；预期新增断言失败。
- [x] **Step 3: 实现**：更新 system prompt、Zod schema、`ConversationDecision` 和会话分派；只允许模型做意图/允许字段抽取，普通 `ANSWER` 走不宣称单据事实的服务端文案。保留既有政策检索入口。
- [x] **Step 4: 验证**：同 Step 2 命令，预期全部通过。
- [x] **Step 5: 提交**：仅提交本任务五个文件，提交信息 `feat: route claim questions through structured intents`。

### Task 3: 生成有来源的金额和只读摘要

**Files:**
- Create: `src/application/format-claim-facts.ts`
- Create: `tests/unit/application/format-claim-facts.test.ts`
- Modify: `src/application/run-conversation-turn.ts`
- Modify: `tests/unit/application/run-conversation-turn.test.ts`
- Modify: `app/api/conversations/private/messages/route.ts`
- Modify: `src/worker/feishu-bot.ts`
- Modify: `tests/integration/api/conversation-routes.test.ts`
- Modify: `tests/integration/feishu-bot-worker.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readWorkbench/readValidation`；Task 2 的三个只读动作。
- Produces: `formatClaimFacts(kind: "READ_CLAIM" | "READ_RECEIPT_AMOUNT" | "READ_SUBMISSION_SUMMARY", workbench: { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] }, validation?: ValidationSnapshot): string`；`RunConversationTurnDeps` 增加 `readWorkbench({ actorId, claimId })` 和 `readValidation({ actorId, claimId })`。`READ_SUBMISSION_SUMMARY` 不更新 Intake，也不申请令牌。

- [x] **Step 1: 写失败测试**：同一单据的申请额、单张发票额、两张票据金额、`null` 金额、识别中/复核中、CNY 格式、校验阻断项分别按 Go 数据回复；无当前 `claimId` 时请求先建单/去 Web；多票据“当前发票”不任选一张；只读摘要不调用 `request_submission_confirmation`；Web 和飞书入口都把只读工具注入会话。
- [x] **Step 2: 运行失败测试**：`npm test -- tests/unit/application/format-claim-facts.test.ts tests/unit/application/run-conversation-turn.test.ts tests/integration/api/conversation-routes.test.ts tests/integration/feishu-bot-worker.test.ts`；预期新增断言失败。
- [x] **Step 3: 实现**：由服务端格式化 Go 工作台和校验结果；只读分支忽略模型 `reply`；Web 与飞书均使用其可信 `actorId`/`turnId` 调用 Task 1 方法。未知金额和 Go 不可用分别表示，绝不用会话历史补值。
- [x] **Step 4: 验证**：同 Step 2 命令，预期全部通过。
- [x] **Step 5: 提交**：仅提交本任务列出的文件，提交信息 `feat: answer claim questions from Go facts`。

### Task 4: 分离准备提交与最终确认

**Files:**
- Modify: `src/application/run-conversation-turn.ts`
- Modify: `tests/unit/application/run-conversation-turn.test.ts`
- Modify: `app/api/conversations/private/messages/route.ts`
- Modify: `src/worker/feishu-bot.ts`
- Modify: `services/agent/src/adapters/reimbursement-api-client.ts`
- Create: `services/agent/src/adapters/reimbursement-api-client.test.ts`
- Modify: `tests/integration/conversation-intake-flow.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `prepareSubmission`、Task 3 的 `readWorkbench/readValidation` 与只读摘要格式化。
- Produces: `RunConversationTurnDeps.prepareSubmission({ actorId, claimId }): Promise<{ token: string; claimId: string; claimVersion: number; workbench: { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] } }>`；`PREPARE_SUBMISSION` 校验通过才设置 `READY_TO_SUBMIT`，`确认提交` 仅使用保存的 token 调用现有 `submitClaim`。

- [x] **Step 1: 写失败测试**：准备提交遇阻断项只回复 Go 校验问题且不保存 token；通过时显示当前金额/事由/票据数并保存 token；未准备直接确认给出引导、不抛 `no ready Intake`；Web 改单据后旧 token 被 Go 拒绝；过期/版本冲突提示重新准备；相同飞书消息重放不重复提交。新增 HTTP 客户端测试固定 `code`、`message`、HTTP 状态的解析行为。
- [x] **Step 2: 运行失败测试**：`npm test -- tests/unit/application/run-conversation-turn.test.ts tests/integration/conversation-intake-flow.test.ts` 和 `npm --prefix services/agent test -- src/adapters/reimbursement-api-client.test.ts`；预期新增断言至少一处失败。
- [x] **Step 3: 实现**：将旧 `REQUEST_SUBMISSION` 分支改为 `PREPARE_SUBMISSION`；先读校验，再申请确认；HTTP 客户端暴露 Go 标准错误 `code`，会话按 `VALIDATION_BLOCKED`、`VERSION_CONFLICT`、`CONFIRMATION_EXPIRED`、`NOT_FOUND` 与 5xx 分别映射安全文案；确认失败时清理过期会话 token 并保留草稿。不得在 `READ_SUBMISSION_SUMMARY` 中申请 token。
- [x] **Step 4: 验证**：同 Step 2 两组命令均通过，并在 `services/reimbursement-api` 运行 `go test ./internal/application` 核对现有 token 绑定和幂等测试。
- [x] **Step 5: 提交**：仅提交本任务列出的文件，提交信息 `feat: require fresh confirmation for agent submission`。

### Task 5: 群聊保护、跨渠道回归与验收说明

**Files:**
- Modify: `src/application/process-feishu-event.ts`
- Modify: `tests/unit/application/process-feishu-event.test.ts`
- Modify: `tests/integration/unified-feishu-identity.test.ts`
- Modify: `tests/integration/feishu-bot-worker.test.ts`
- Modify: `tests/integration/api/conversation-routes.test.ts`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `docs/feishu-integration.md`

**Interfaces:**
- Consumes: Task 2 的动作、Task 3 的只读回复、Task 4 的准备与确认。
- Produces: 飞书群聊消息的敏感动作拦截；私聊/Web 相同员工数据与提交结果验收流程；不改变 Go 的归属权限。

- [x] **Step 1: 写失败测试**：群聊 @bot 询问金额、摘要或“确认提交”不调用 Go 敏感工具且提示转私聊/Web；同一 `open_id` 的飞书与 Web 映射同一员工 ID；另一员工询问同一 `claimId` 不泄露金额或单据存在性；飞书成功提交后 Web 列表出现同一提交编号。Go HTTP 测试固定非归属员工查询/提交不可访问。
- [x] **Step 2: 运行失败测试**：`npm test -- tests/unit/application/process-feishu-event.test.ts tests/integration/unified-feishu-identity.test.ts tests/integration/feishu-bot-worker.test.ts tests/integration/api/conversation-routes.test.ts`，并在 `services/reimbursement-api` 运行 `go test ./internal/transport/http`；预期新增断言失败。
- [x] **Step 3: 实现**：`processFeishuEvent` 将可信 `chatType` 传给 `runConversationTurn`；会话层在读取金额/摘要、准备提交及固定“确认提交”之前拒绝 `group`，绝不先调用敏感工具；不影响群聊公开政策问答。更新 `docs/feishu-integration.md` 的私聊验收步骤及“摘要→准备→确认”文案。
- [x] **Step 4: 局部验证**：同 Step 2 命令，预期全部通过。
- [x] **Step 5: 全量验证**：`npm test`、`npm run lint`、`npx tsc --noEmit`、`npm --prefix services/agent test`；在 `services/reimbursement-api` 运行 `go test ./...`。仅在全部退出码为 0 时报告通过；若依赖服务未启动，记录不可运行的项目和原因。
- [x] **Step 6: 提交**：仅提交本任务列出的文件，提交信息 `test: verify cross-channel claim read and submit`。

## 手工验收

1. 启动 Go API、Web、飞书 Worker 及报销依赖；确认飞书私聊与 Web 是同一 `open_id` 映射的员工。
2. 在飞书私聊“新建报销”并上传一张可识别金额的票据；问“当前发票金额是多少”和“申请报销总额是多少”，与 `http://localhost:8088/claims/<claimId>` 比对，确认两种金额未混淆。
3. 问“生成提交摘要”，核对已知信息和缺失项；此时不应出现已准备提交或已提交状态。
4. 在 Web 补齐必要字段后于飞书说“提交报销”；检查收到 Go 当前版本的确认信息，再发“确认提交”，核对提交编号与 Web 列表一致。直接跳过准备、改完单据再确认和重复发送同一消息均不得产生第二张提交单。
5. 用另一员工或群聊尝试读取金额/提交，确认不泄露、不写入。公开政策问答仍可用。

## 交付说明

按任务顺序执行并逐项勾选；每项仅在红灯→绿灯验证后提交。完成后复核本设计的安全边界、Go 归属校验、Agent 工具账本与手工飞书链路；不把本地 `localhost` 链接可从手机打开当作验收前提。
