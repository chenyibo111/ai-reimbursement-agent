# Agent 本人单据工作区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 员工能在飞书私聊和 Web 私有会话中按条件查本人单据、指定草稿办理票据和字段、明确确认删除或提交，并查询真实进度。

**Architecture:** 模型只输出类型化意图与条件；Agent 持久化搜索、只读和办理目标；所有报销事实及写入经现有工具网关调用 Go。Go 强制本人过滤、草稿状态、版本、幂等与审计。审批和付款仅预留进度接入点。

**Tech Stack:** Go/pgx/PostgreSQL、OpenAPI、TypeScript/Vitest、Prisma、Next.js 飞书/Web Agent、React 工作台、NATS JetStream。

**Spec:** `docs/superpowers/specs/2026-10-26-agent-claim-search-and-workspace-design.md`

## Global Constraints

- Agent 聊天只写 `purpose`、`expenseCategory`、`participants`、`projectCode`；金额、币种、备注和 OCR 人工修正仍由 Web/财务流程处理。
- 查询数量 1–100，默认 5；飞书每页最多 10 条，单条回复最多 1000 字。Go 单据状态只有 `DRAFT` 和 `SUBMITTED`。
- 私人单据不在群聊回显；Go 始终从已认证员工身份限定 `owner_id`，不接收模型提供的员工 ID。
- 查询目标、办理目标、当前 Intake 分离；删除和提交使用绑定员工、目标、版本及有效期的一次性确认。
- 开始 Task 1 前，重跑当前 HELP 定向测试并将那两个已存在的未提交文件单独提交为 `fix(agent): list current capabilities`；随后每个任务只提交自身改动，避免混入旧工作。
- 集成测试只连接独立 `reimbursement_test` 库；不得在运行中的业务开发库执行清理型测试。

## Review Focus

- 相同金额或创建时间的分页边界不得漏单/重复：Task 1 固定 `(sort_value,id)` 游标测试。
- 未填写申请金额不得匹配金额范围或展示成零：Task 1 的过滤测试。
- 新搜索后“第二张”不得引用旧页：Task 3 的序号过期测试。
- 同名票据删除必须按稳定 `receiptId`：Task 5 的重复文件名测试。
- Web 并发修改后旧删除/提交确认不可用：Task 6–7 的版本冲突测试。

## File Map

- Go 查询、删除、进度：`services/reimbursement-api/internal/{application,store,transport/http}`，契约 `api/openapi/reimbursement-v1.yaml`。
- Agent Go 边界：`services/agent/src/{ports,adapters,tool-gateway}`。
- Agent 对话：`src/application/run-conversation-turn.ts` 与新 `claim-search.ts`、`claim-target.ts`、`claim-progress.ts`；模型 `src/infrastructure/model`；会话仓储 `src/infrastructure/prisma/agent-conversation-repository.ts`、`prisma/schema.prisma` 与迁移。
- 渠道和通知：`app/api/conversations/private`、`src/worker/feishu-bot.ts`、`src/worker/agent-event-worker.ts`、`services/agent/src/events`。
- React：`apps/web/src/api/client.ts`、`apps/web/src/routes/claims-list-page.tsx`。

---

### Task 1: Go 本人条件搜索

**Files:** 修改 `services/reimbursement-api/internal/application/claim_service.go`、`internal/store/claim_repository.go`、`internal/transport/http/claims_handler.go`、`api/openapi/reimbursement-v1.yaml`；测试同目录 `_test.go`。

**Interfaces:** `SearchClaimsQuery{Status,CreatedFrom,CreatedBefore,PurposeContains,ExpenseCategory,MinRequestedAmountCent,MaxRequestedAmountCent,Sort,Limit,Cursor,CountOnly}`；`SearchClaimsPage{Items,TotalCount,NextCursor}`；`ClaimService.SearchClaims(ctx,actorID,query)`；扩展 `GET /api/v1/claims`，保留精确 `claimNumber` 语义。

- [x] **Step 1: 写失败测试。** 建 12 条本人匹配单、若干他人单；`limit=10` 返回 10/总数 12，下一页 2；相同排序值无重复；金额为空不匹配区间；无效状态、范围和游标返回 400。
- [x] **Step 2: 验证红灯。** 在 `services/reimbursement-api` 执行 `go test ./internal/application ./internal/store ./internal/transport/http`，新增测试因搜索接口缺失而失败。
- [x] **Step 3: 实现最小代码。** SQL 先 `owner_id` 过滤再过滤/计数/稳定游标分页；请求数限 1–100；日期按业务时区解释；使用参数化 SQL，并更新 OpenAPI。
- [x] **Step 4: 验证绿灯。** 同一测试命令及 `go test ./...` 通过。
- [x] **Step 5: 提交。** 只提交本任务文件，消息 `feat(go): search owned claims with filters and cursor`。

### Task 2: 类型化 Agent 搜索工具

**Files:** 修改 `services/agent/src/ports/reimbursement-port.ts`、`adapters/reimbursement-api-client.ts`、`tool-gateway/{reimbursement-tools,conversation-reimbursement}.ts` 及对应 `.test.ts`。

**Interfaces:** `OwnedClaimSearchQuery` 对应 Task 1 查询字段；`OwnedClaimSearchPage{items:ClaimSnapshot[],totalCount:number,nextCursor:string|null}`；网关工具 `search_owned_claims`。

- [x] **Step 1: 写失败测试。** 条件、排序、游标正确 URL 编码；`ownerId`、非法数量和未知字段被拒绝；`null` 金额保持 `null`；同一调用重放不再次请求 Go。
- [x] **Step 2: 验证红灯。** 在 `services/agent` 执行 `npm test -- src/adapters/reimbursement-api-client.test.ts src/tool-gateway/reimbursement-tools.test.ts`，新增测试失败。
- [x] **Step 3: 实现最小代码。** 扩展 port/client/gateway/adapter，严格校验 Go 响应，复用既有 Agent JWT、服务密钥和调用账本。
- [x] **Step 4: 验证绿灯。** 定向测试及 `npm test` 通过。
- [x] **Step 5: 提交。** `feat(agent): add typed owned-claim search tool`。

### Task 3: 对话搜索、指定数量与翻页

**Files:** 新建 `src/application/claim-search.ts`；修改 `src/application/run-conversation-turn.ts`、`src/infrastructure/model/{chat-model,openai-compatible-chat-model}.ts`、`src/infrastructure/prisma/agent-conversation-repository.ts`、`prisma/schema.prisma` 和迁移；测试 `tests/unit/application/run-conversation-turn.test.ts`、`tests/unit/infrastructure/openai-compatible-chat-model.test.ts`、`tests/integration/agent-conversation-repository.test.ts`。

**Interfaces:** 模型动作 `SEARCH_CLAIMS` 输出类型化筛选、请求数或 `countOnly`；`searchState` 保存条件、游标、剩余数、过期时间和最近展示页序号→Go ID/单号映射。`runClaimSearch(decision,state,searchOwnedClaims)` 产出回复和下一状态。

- [x] **Step 1: 写失败测试。** “上月草稿列 12 张”在飞书首条最多 10 张，下一页剩余 2；“一共几张”返回 Go 总数；“第二张”选当前页 ID；新搜索/过期页/无效条件不能引用旧页或退化成无条件查询。
- [x] **Step 2: 验证红灯。** `npx vitest run tests/unit/application/run-conversation-turn.test.ts tests/unit/infrastructure/openai-compatible-chat-model.test.ts` 失败。
- [x] **Step 3: 实现最小代码。** 严格解析模型结果，服务端规范化条件及 `Asia/Shanghai` 自然日期，持久化有限搜索状态；接线 Web 与飞书；回复截断时保持游标/总数一致。
- [x] **Step 4: 验证绿灯。** 定向测试、测试库 Prisma 迁移与仓储集成测试通过。
- [x] **Step 5: 提交。** `feat(agent): search and page owned claims in conversation`。

### Task 4: 明确选择可办理草稿

**Files:** 新建 `src/application/claim-target.ts`；修改 `run-conversation-turn.ts`、模型契约、会话仓储/schema/迁移及相关测试。

**Interfaces:** `selectedEditClaimId` 独立于 `selectedReadClaimId` 与 `ReimbursementIntake.claimId`；动作 `SELECT_EDIT_CLAIM` 接完整单号或有效列表序号；`resolveWriteTarget(...)` 只返回 Go 核验的本人 `DRAFT` 或澄清。

- [x] **Step 1: 写失败测试。** 只读 A、活动 Intake B 并存时不会误写；“编辑 A”选本人草稿 A 且保留 B；他人/已提交 A 不能选；“改这张”指代不明时澄清。
- [x] **Step 2: 验证红灯。** `npx vitest run tests/unit/application/run-conversation-turn.test.ts` 失败。
- [x] **Step 3: 实现最小代码。** 独立持久化办理目标；每次操作前回读 Go 验证；明确回显单号，切换或新建 Intake 时按规格清理选择。
- [x] **Step 4: 验证绿灯。** 定向测试和 `npx tsc --noEmit` 通过。
- [x] **Step 5: 提交。** `feat(agent): select an owned draft for editing`。

### Task 5: 指定草稿补字段与票据管理

**Files:** 修改 `run-conversation-turn.ts`、`claim-target.ts`、`services/agent/src/{ports,adapters,tool-gateway}`、Web 附件路由、飞书 Worker；修改 Go `internal/application/receipt_service.go`、`internal/store/receipt_repository.go`、HTTP handler/OpenAPI 和测试。

**Interfaces:** `COLLECT_FIELDS`、附件上传先调用 `resolveWriteTarget`；`delete_owned_receipt(context,{claimId,receiptId,expectedClaimVersion})` 调扩展后的 Go 删除接口；一次性 `pendingAction{kind:'DELETE_RECEIPT',claimId,claimVersion,receiptId,expiresAt}`。

- [x] **Step 1: 写失败测试。** 选中 A 后补四字段/上传只影响 A，Intake B 保留；无明确目标不上传；两张同名票据中“删除第二张”只预览第二个 `receiptId`，确认后删一次；并发 Web 改动使确认失效；对象删除失败留下可重试清理而不是含文件的失效票据；新文件上传失败不删除旧文件。
- [x] **Step 2: 验证红灯。** 定向运行 Agent 网关、`run-conversation-turn` 与飞书附件测试，新增测试失败。
- [x] **Step 3: 实现最小代码。** 写入继续用 Go 版本 PATCH 与回读确认；票据删除需单号/文件/稳定 ID 预览和限时确认。Go 以 claim 版本/草稿状态的事务检查先删除或标记票据并持久化对象清理任务，再异步幂等删对象，不再先删对象后写库；所有变更清除旧提交准备，金额等不可聊改字段给目标 Web 链接。
- [x] **Step 4: 验证绿灯。** 定向 Node/Agent 测试与 Go 票据测试通过。
- [x] **Step 5: 提交。** `feat(agent): manage receipts and fields on selected draft`。

### Task 6: 删除本人草稿

**Files:** 修改 Go router/handler/OpenAPI、对象清理实现及测试；Agent port/client/gateway、对话确认状态和测试。

**Interfaces:** `DELETE /api/v1/claims/{claimId}` 带预期版本与幂等键，调用已有 `ClaimService.DeleteClaim`；Agent 工具 `delete_owned_draft`；`pendingAction.kind='DELETE_DRAFT'`。

- [x] **Step 1: 写失败测试。** 预览完整单号和票据数；只有本人 `DRAFT` 且版本未变时一次性确认可删除；他人/已提交/并发 Web 改动不可删除；对象清理失败可重试且不回复全部清理成功。
- [x] **Step 2: 验证红灯。** Go handler/store 与 Agent 确认测试失败。
- [x] **Step 3: 实现最小代码。** 暴露 Go 删除用例、审计/Outbox；删除前在同一事务中保存被级联删除票据的对象键到 Task 5 的清理队列，供幂等重试。确认后清除会话中指向该单的搜索/读/办目标和待确认动作。
- [x] **Step 4: 验证绿灯。** `go test ./...`、Agent 定向测试通过。
- [x] **Step 5: 提交。** `feat(reimbursement): confirm and delete owned draft`。

### Task 7: 指定草稿两阶段提交

**Files:** 修改 `run-conversation-turn.ts`、`claim-target.ts`、会话仓储/schema 与相关测试。

**Interfaces:** `pendingAction{kind:'SUBMIT',claimId,claimVersion,confirmationToken,preview,expiresAt}` 同时服务当前 Intake 和显式选中旧草稿；旧 Intake-only Token 首次使用时失效并要求重新准备。

- [x] **Step 1: 写失败测试。** 旧草稿 A 可准备/确认提交，活动 B 不受影响；只读 A 不可提交；目标切换、字段/票据变化、过期或版本冲突使旧确认失效；重投不重复提交。
- [x] **Step 2: 验证红灯。** `npx vitest run tests/unit/application/run-conversation-turn.test.ts` 失败。
- [x] **Step 3: 实现最小代码。** 准备阶段从 Go 读取最新校验、金额、版本；精确“确认提交”只消费当前有效动作，成功/失败均清理状态，保留既有 Intake 路径。
- [x] **Step 4: 验证绿灯。** 定向测试、根目录 `npm test` 与 `npx tsc --noEmit` 通过。
- [x] **Step 5: 提交。** `feat(agent): submit explicitly selected owned draft`。

### Task 8: 员工可见进度与缺项指引

**Files:** 新建 Go 员工安全进度投影/handler，修改 Go router/OpenAPI/测试；新建 `src/application/claim-progress.ts`，修改 Agent port/client/gateway、模型意图及对话测试。

**Interfaces:** `GET /api/v1/claims/{claimId}/progress` 返回本人单据状态、票据/OCR、员工可见复核摘要、提交记录和校验问题；`approval`/`payment` 为 `NOT_CONNECTED` 扩展槽。Agent `get_owned_claim_progress` 只读。

- [x] **Step 1: 写失败测试。** 草稿缺项、OCR 中、待复核、复核已处理、已提交分别输出准确下一步；财务内部意见不外泄；他人单号安全拒绝；未接入审批/付款明确说明而不虚构状态。
- [x] **Step 2: 验证红灯。** Go handler 和 Agent 对话定向测试失败。
- [x] **Step 3: 实现最小代码。** Go 组合真实记录并裁剪员工安全字段；Agent 将阻断项映射为对话可补或目标 Web 链接，时间线不取聊天摘要当事实。
- [x] **Step 4: 验证绿灯。** `go test ./...`、Agent/Node 定向测试通过。
- [x] **Step 5: 提交。** `feat(reimbursement): expose employee-safe claim progress`。

### Task 9: 进度通知与目标订阅

**Files:** 修改 `services/agent/src/events/{reimbursement-consumer,jetstream-durable-consumer}.ts`、`src/worker/{agent-event-worker,agent-event-runtime}.ts`、会话通知目标仓储和测试；修改 Go 复核解决流程与 Outbox 测试，新增复核已处理事件。

**Interfaces:** 订阅已验证的员工私聊与 `claimId`；消费 OCR 完成/失败、复核需要/解决、提交完成事件；按 `event_id` 去重。现有 OCR durable 不重置，新增事件使用新 durable。

- [ ] **Step 1: 写失败测试。** 选中旧草稿上传也能关联通知目标；事件重投只发送一次；无可信私聊目标或 Go 当前读取失败不泄漏数据；复核与提交通知来自 Go 最新状态。
- [ ] **Step 2: 验证红灯。** Agent events、worker 测试失败。
- [ ] **Step 3: 实现最小代码。** 扩展目标登记与事件消费者，让 Go review resolution 发 `ReceiptReviewResolved` Outbox；另建通知 durable 而不重置现有 OCR durable，按现有投递账本重试和去重，不把未接入审批/付款阶段伪装成通知。
- [ ] **Step 4: 验证绿灯。** Agent、根目录通知测试与 Go 事件测试通过。
- [ ] **Step 5: 提交。** `feat(agent): notify employee of verified claim progress`。

### Task 10: React 对齐与整体验收

**Files:** 修改 `apps/web/src/api/client.ts`、`apps/web/src/routes/claims-list-page.tsx` 及测试；更新 `src/application/run-conversation-turn.ts` 的 HELP 能力清单和 `docs/operations/agent-owned-claim-acceptance.md`；新增双员工与 101+ 单据集成测试。

**Interfaces:** React 使用 Task 1 查询合同显示筛选、总数与分页；Agent 返回的准确单号和工作台链接保持可打开。本期不增加 React Agent 悬浮入口。

- [ ] **Step 1: 写失败测试。** React 与飞书筛选/总数一致；旧单可在 101+ 数据中检索；群聊不显示私有内容；跨员工越权失败；定向草稿修改/删除/提交与 Web 刷新结果一致。
- [ ] **Step 2: 验证红灯。** `apps/web` 测试及根目录定向集成测试失败。
- [ ] **Step 3: 实现最小代码。** 绑定列表筛选和分页，更新 HELP 能力清单、验收文档与部署顺序；检查动态公开域名不可用时只展示单号，不给失效示例链接。
- [ ] **Step 4: 验证绿灯。** `apps/web` 测试/构建、根目录 `npm test`/lint/build/TS、Go `go test ./...`；完成一条 Web 与一条飞书双员工手工链路。
- [ ] **Step 5: 提交。** `feat(web): align searchable claim workspace with Agent`。

## 完成条件

逐项勾选并提交 Task 1–10；复核规格每条验收标准都落在测试或人工记录中。未经真实财务流程接入，不把审批/付款标记为通过。保留当前 HELP 文案的未提交修改，除非另行在独立提交中明确处理。
