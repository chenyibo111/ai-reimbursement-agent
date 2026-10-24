# Agent Go 工具网关硬切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web 私有对话与飞书机器人全部切换为经 Go 工具网关办理报销领域动作，删除 Node/Prisma 报销办理兜底。

**Architecture:** Agent 继续拥有会话、模型、政策检索、工具账本和渠道投递。共享运行时工厂创建 `ReimbursementApiClient` + `ReimbursementToolGateway` 并注入两个入口；Go 报销 API 成为唯一的票据、OCR、校验、提交、审计和 Outbox 事实源。缺配置或上游故障安全失败，绝不回退。

**Tech Stack:** TypeScript、Next.js Route Handlers、Node Worker、Prisma（仅身份/会话/工具账本）、Go HTTP API、JWT、NATS、MinIO、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-23-agent-go-tool-gateway-cutover-design.md`

## Global Constraints

- 不引入 MCP、新 Agent 框架、自动提交或新模型供应商。
- 删除 `REIMBURSEMENT_AGENT_MODE`，不保留运行时 feature flag 或 Prisma 领域回退。
- Agent 仅拥有会话、模型、政策检索、投递和工具结果账本；报销领域状态只由 Go 写入。
- 所有 Agent 到 Go 的调用必须有 `channel=agent` JWT、`X-Agent-Service-Key`、稳定 `Idempotency-Key`。
- Web 使用持久化 `turnId`，飞书使用验证后的入站消息 ID；重放不得重复写入。
- 配置、鉴权和 Go API 故障必须安全失败，禁止写旧数据库领域路径。
- 普通 React/Go 工作台、RAG、模型 Provider、MCP 不在本期范围。

## Review Focus

- 附件先到、事由后补时，应允许空事由草稿并继续上传；Task 1。
- 同一 Web `turnId` 或飞书消息重放不能重复草稿、上传或提交；Task 3、4。
- Go API 不可用或密钥缺失时，两个入口只能返回可恢复错误；Task 2–4。
- 身份只可来自服务端会话或验证过的 `open_id` 投影；Task 2、5。
- Docker 中 MinIO 内网预签名 URL 与浏览器可访问 Host 必须兼容；Task 3。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `services/agent/src/ports/reimbursement-port.ts` | 通用 Agent 报销工具和回合上下文类型。 |
| `services/agent/src/tool-gateway/reimbursement-tools.ts` | 八个受控工具、字段限制、账本与幂等。 |
| `services/agent/src/tool-gateway/conversation-reimbursement.ts` | 会话动作到工具调用的确定性映射。 |
| `src/agent/reimbursement-runtime.ts` | Web/飞书共用的 Go 工具运行时工厂。 |
| `src/server/employee-identity.ts` | 可信员工身份与角色投影。 |
| 两个 `app/api/conversations/private/*` 路由 | Web 回合和附件的 Go-only 入口。 |
| `src/worker/feishu-bot.ts` | 飞书 Go-only Agent 入口。 |
| 环境、Compose、文档与契约测试 | 无回退运行约束及部署说明。 |

### Task 1: 泛化 Agent 工具回合上下文

**Files:**
- Modify: `services/agent/src/ports/reimbursement-port.ts`
- Modify: `services/agent/src/tool-gateway/reimbursement-tools.ts`
- Modify: `services/agent/src/tool-gateway/conversation-reimbursement.ts`
- Modify: `services/agent/src/tool-gateway/reimbursement-tools.test.ts`
- Modify: `services/agent/src/tool-gateway/conversation-reimbursement.test.ts`

**Interfaces:**
- Consumes: 既有八个 `ReimbursementPort` 方法与 `AgentToolCall` 账本。
- Produces: `ConversationReimbursementContext = { actorId; actorRole; channel: "WEB" | "FEISHU"; conversationId; turnId }`，并由 `createConversationReimbursementTools(context, gateway)` 生成 `<turnId>:<tool-name>` 调用 ID。

- [ ] **Step 1: 写失败测试**
  为 WEB 渠道、同一 `turnId` 的稳定 ID、空 `purpose` 建草稿后上传增加断言；保留非法字段被拒绝的断言。
- [ ] **Step 2: 运行失败测试**
  Run: `npm --prefix services/agent test -- src/tool-gateway/conversation-reimbursement.test.ts src/tool-gateway/reimbursement-tools.test.ts`
  Expected: FAIL，原因是仅支持 FEISHU 或空事由被拒绝。
- [ ] **Step 3: 实现通用上下文和附件优先建单**
  用 `turnId` 替换渠道专属消息 ID；让 `create_claim_draft` 接受可选/空事由并原样交给 Go，不能放宽 `update_claim_fields` 白名单或提交确认限制。
- [ ] **Step 4: 验证通过**
  Run: `npm --prefix services/agent test -- src/tool-gateway/conversation-reimbursement.test.ts src/tool-gateway/reimbursement-tools.test.ts`
  Expected: PASS。
- [ ] **Step 5: 提交**
  Run: `git add services/agent/src/ports/reimbursement-port.ts services/agent/src/tool-gateway/reimbursement-tools.ts services/agent/src/tool-gateway/conversation-reimbursement.ts services/agent/src/tool-gateway/reimbursement-tools.test.ts services/agent/src/tool-gateway/conversation-reimbursement.test.ts && git commit -m "feat: generalize agent reimbursement tools"`

### Task 2: 建立共享 Go 工具运行时与可信身份

**Files:**
- Create: `src/agent/reimbursement-runtime.ts`
- Create: `tests/unit/agent/reimbursement-runtime.test.ts`
- Modify: `src/server/employee-identity.ts`
- Modify: `tests/unit/server/employee-identity.test.ts`

**Interfaces:**
- Consumes: Task 1 上下文、现有 `ReimbursementApiClient`、`ReimbursementToolGateway`。
- Produces: `createAgentReimbursementRuntime(dependencies)` 返回 `tools`；`resolveAgentActor(employeeId)` 返回服务端投影的 `{ id, role }`。

- [ ] **Step 1: 写失败测试**
  覆盖缺少 `REIMBURSEMENT_API_URL`、`REIMBURSEMENT_AGENT_SERVICE_KEY`、`REIMBURSEMENT_AUTH_HS256_SECRET` 时的配置错误；覆盖忽略客户端角色、仅使用服务端存储员工角色。
- [ ] **Step 2: 运行失败测试**
  Run: `npm test -- tests/unit/agent/reimbursement-runtime.test.ts tests/unit/server/employee-identity.test.ts`
  Expected: FAIL，运行时工厂和可信 actor 解析尚不存在。
- [ ] **Step 3: 实现工厂与身份投影**
  工厂启动时校验三项必需变量，创建附带 Agent JWT、服务密钥和可选存储端点覆盖的 HTTP 客户端、工具网关；身份函数仅从服务端员工/飞书投影读取 ID、角色。
- [ ] **Step 4: 验证通过**
  Run: `npm test -- tests/unit/agent/reimbursement-runtime.test.ts tests/unit/server/employee-identity.test.ts`
  Expected: PASS。
- [ ] **Step 5: 提交**
  Run: `git add src/agent/reimbursement-runtime.ts src/server/employee-identity.ts tests/unit/agent/reimbursement-runtime.test.ts tests/unit/server/employee-identity.test.ts && git commit -m "feat: add shared agent reimbursement runtime"`

### Task 3: Web 私有会话硬切至 Go 工具

**Files:**
- Modify: `app/api/conversations/private/messages/route.ts`
- Modify: `app/api/conversations/private/attachments/route.ts`
- Modify: `tests/integration/api/conversation-routes.test.ts`
- Modify: `tests/integration/conversation-intake-flow.test.ts`

**Interfaces:**
- Consumes: Task 1 的上下文与 Task 2 的运行时。
- Produces: 文本和附件 API 均接收稳定 `turnId`；附件只经 `create_upload_session`、预签名 PUT、`finalize_receipt_upload` 进入 Go 流程。

- [ ] **Step 1: 写失败测试**
  文本入口使用 `{ message, turnId }`，断言上下文为 WEB，重试不重复建单；附件可在空事由草稿时完成 Go 归档；配置/API 故障时返回安全错误且不调用旧 `ClaimDraft`、票据、OCR、提交用例。
- [ ] **Step 2: 运行失败测试**
  Run: `npm test -- tests/integration/api/conversation-routes.test.ts tests/integration/conversation-intake-flow.test.ts`
  Expected: FAIL，路由仍构造 Prisma 报销依赖或不接受 `turnId`。
- [ ] **Step 3: 替换路由领域依赖**
  删除 `PrismaClaimRepository`、`PrismaReceiptRepository`、`PrismaAsyncJobRepository` 和旧上传/OCR/提交用例；保留会话、模型、政策依赖。由服务端身份创建 WEB 上下文，Go 工具错误映射为不泄露内部信息的可重试响应。
- [ ] **Step 4: 验证通过**
  Run: `npm test -- tests/integration/api/conversation-routes.test.ts tests/integration/conversation-intake-flow.test.ts`
  Expected: PASS。
- [ ] **Step 5: 提交**
  Run: `git add app/api/conversations/private/messages/route.ts app/api/conversations/private/attachments/route.ts tests/integration/api/conversation-routes.test.ts tests/integration/conversation-intake-flow.test.ts && git commit -m "feat: route web agent conversations through Go tools"`

### Task 4: 飞书机器人硬切至同一运行时

**Files:**
- Modify: `src/worker/feishu-bot.ts`
- Modify: `tests/integration/feishu-bot-worker.test.ts`
- Modify: `tests/integration/feishu-bot-attachment.test.ts`
- Modify: `tests/integration/cross-channel-conversation.test.ts`
- Modify: `tests/unit/worker/feishu-bot-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 通用上下文、Task 2 运行时。
- Produces: 已验证飞书消息 ID 作为 `turnId`；文字与附件操作固定走 `ReimbursementToolGateway`。

- [ ] **Step 1: 写失败测试**
  覆盖缺 Go 配置时仅返回配置错误、不调用 Prisma；消息重投只产生一次同键工具调用；飞书附件使用 Go 上传/完成归档；跨渠道不混用会话但共享同一 Go 报销事实。
- [ ] **Step 2: 运行失败测试**
  Run: `npm test -- tests/integration/feishu-bot-worker.test.ts tests/integration/feishu-bot-attachment.test.ts tests/integration/cross-channel-conversation.test.ts tests/unit/worker/feishu-bot-runtime.test.ts`
  Expected: FAIL，`REIMBURSEMENT_AGENT_MODE` 或旧路径仍存在。
- [ ] **Step 3: 删除模式开关与旧兜底**
  无条件创建 Task 2 运行时，删除 `REIMBURSEMENT_AGENT_MODE`、可空 Go 工具、旧报销仓储、对象存储、扫描、OCR、提交依赖。用经过签名校验的消息 ID 与 FEISHU 渠道构造上下文；保留飞书签名校验、消息记录和回复。
- [ ] **Step 4: 验证通过**
  Run: `npm test -- tests/integration/feishu-bot-worker.test.ts tests/integration/feishu-bot-attachment.test.ts tests/integration/cross-channel-conversation.test.ts tests/unit/worker/feishu-bot-runtime.test.ts`
  Expected: PASS。
- [ ] **Step 5: 提交**
  Run: `git add src/worker/feishu-bot.ts tests/integration/feishu-bot-worker.test.ts tests/integration/feishu-bot-attachment.test.ts tests/integration/cross-channel-conversation.test.ts tests/unit/worker/feishu-bot-runtime.test.ts && git commit -m "feat: make Feishu agent use Go tools only"`

### Task 5: 固化配置、无回退边界与运行手册

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `src/worker/agent-event-worker.ts`
- Modify: `tests/contract/no-direct-domain-db-access.test.ts`
- Modify: `tests/integration/docker-worker-compose.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 Go-only 运行方式。
- Produces: 唯一受支持的 Agent 环境变量与 Compose 依赖，以及禁止 Agent 入口重新依赖 Node/Prisma 报销领域的契约测试。

- [ ] **Step 1: 写失败测试**
  契约测试扫描两个 Web 路由和飞书 Worker，拒绝模式变量、Prisma 报销/票据/任务仓储及旧报销写用例导入。Compose 测试断言 Web、飞书 Worker、事件 Worker 都有 Go API、服务密钥、JWT 密钥，且仍有 `REIMBURSEMENT_AGENT_STORAGE_ENDPOINT`。
- [ ] **Step 2: 运行失败测试**
  Run: `npm test -- tests/contract/no-direct-domain-db-access.test.ts tests/integration/docker-worker-compose.test.ts`
  Expected: FAIL，发现遗留模式变量或 Agent Worker 可选 Go 模式。
- [ ] **Step 3: 固化运行与回滚约束**
  删除示例变量、Compose 与文档中的 `REIMBURSEMENT_AGENT_MODE`；事件 Worker 强制使用 Go 配置。文档声明发布前 Go API、NATS、对象存储与密钥均须就绪；异常靠回滚整体应用镜像/部署版本，禁止切换到 Node/Prisma。
- [ ] **Step 4: 验证通过**
  Run: `npm test -- tests/contract/no-direct-domain-db-access.test.ts tests/integration/docker-worker-compose.test.ts`
  Expected: PASS。
- [ ] **Step 5: 提交**
  Run: `git add .env.example docker-compose.yml README.md docs/operations.md src/worker/agent-event-worker.ts tests/contract/no-direct-domain-db-access.test.ts tests/integration/docker-worker-compose.test.ts && git commit -m "docs: document agent Go tool cutover"`

### Task 6: 完整验证与验收记录

**Files:**
- Modify: `docs/superpowers/plans/2026-10-23-agent-go-tool-gateway-cutover.md`

**Interfaces:**
- Consumes: Tasks 1–5 的工具、入口和配置。
- Produces: 自动化验证和 Web/飞书手工验收的可复现记录。

- [ ] **Step 1: 运行自动化验证**
  Run: `npm --prefix services/agent test`
  Run: `npm test`
  Run: `npm --prefix apps/web test`
  Run: `npm --prefix apps/web run build`
  Run: `docker compose --profile migration config --quiet`
  Run: `docker run --rm -v "$"+"{PWD}:/workspace" -w /workspace/services/reimbursement-api golang:1.27.1-alpine go test ./...`
  Run: `git diff --check`
  Expected: 全部退出码为 0；外部服务/Docker 不可用则记录阻塞原因，不能跳过。
- [ ] **Step 2: 启动硬切换环境**
  Run: `docker compose --profile migration --profile knowledge up -d --build web feishu-bot-worker agent-event-worker reimbursement-api reimbursement-worker reimbursement-edge`
  Expected: 所列服务健康或稳定运行，日志不出现 legacy/Prisma 回退。
- [ ] **Step 3: 执行手工验收并记录**
  Web：开始报销、补充事由、上传票据、查看校验、明确确认提交。飞书：重放同一入站消息并上传票据，确认每项领域动作只有一次。临时令 Go API 不可达，确认两入口安全失败且无旧库写入。将时间、命令、报销单号和结果写入下方记录。
- [ ] **Step 4: 提交验收记录**
  Run: `git add docs/superpowers/plans/2026-10-23-agent-go-tool-gateway-cutover.md && git commit -m "test: verify agent Go tool gateway cutover"`

## 验证记录

2026-10-24 本地实施记录：

- Tasks 1–5 代码已实现。Web 私有对话与飞书机器人复用 Go 工具运行时；附件、事由更新、提交确认与正式提交都不再调用 Node/Prisma 报销写入用例。`REIMBURSEMENT_AGENT_MODE` 已移除。相较原计划，沿用已存在的 `ensureStoredEmployee` / `createFeishuIdentityEnsurer` 作为可信身份投影，没有再造一个同义的 `resolveAgentActor`。
- Agent 包测试：16/16；根目录单元、契约及 Compose 测试：213/213；Web React 测试：34/34；Web 会话路由集成测试：6/6；飞书附件与运行时隔离测试：9/9；Go `go test ./...`：通过；Next.js 生产构建、ESLint（本次变更源码）、`docker compose --profile migration config --quiet`、`git diff --check`：通过。
- 缺少 Go API 配置的故障注入集成测试返回 503，且不创建旧 `ClaimDraft` 或 Agent Intake。Web 附件集成测试验证 Go 建单、上传会话、预签名 PUT、完成归档及同一 `turnId` 重放只调用一次上游。
- 最终镜像重新构建并重新启动后，`web`、`feishu-bot-worker`、`agent-event-worker`、`reimbursement-api` 均保持运行；Web Ready、飞书 Worker 有启动与心跳、事件 Worker 为 ready。未登录的只读 HTTP 冒烟检查：`/api/conversations/private` 返回 401，Go edge `/api/v1/claims` 返回 401，符合鉴权预期。
- 已运行 `docker compose --profile migration --profile knowledge up -d --build web feishu-bot-worker agent-event-worker reimbursement-api reimbursement-worker reimbursement-edge`。所列服务保持运行；Go API 日志显示监听 8080，飞书机器人与 Agent 事件 Worker 均报告启动，Web 报告 Ready。构建时发现旧 `.worktrees` 增大 Docker context，现已排除；曾尝试递归排除子项目 `node_modules`，但当前 Dockerfile 的 Next.js 类型检查仍依赖 React 子项目已安装的依赖，因此撤回该项优化，待单独改造 Dockerfile。
- `npx tsc --noEmit` 仍被四处与本次改动无关的既有测试夹具类型错误阻断：React 报销工作台测试缺 `closedByReview`、飞书事件测试使用旧接口、权限测试缺 `NODE_ENV`、飞书运行时测试缺 `attemptCount`。本次改动没有新增类型错误；生产 `next build` 通过。
- 尚未执行真实账号的 Web 与飞书端到端操作，也未获得可记录的报销单号。飞书事件重放和 Go API 中断的完整渠道验收仍待人工操作；不能据此宣称 Task 6 全部完成。未运行无筛选的 `npm test`，因为部分旧集成测试对共享测试库使用全表 `deleteMany`；改为限定测试文件和隔离测试库验证。
- 任务提交采用分组提交而非计划中的每一步单独提交；这不改变运行边界与验收结论。

## Self-Review

- **Spec coverage:** 六项任务覆盖工具、运行时、Web、飞书、配置边界和验收，未越过设计排除的工作台、RAG、MCP、自动提交。
- **Step scan:** 每项均按失败测试、确认失败、最小实现、确认通过、提交拆分；不可自动化的渠道验收集中于 Task 6。
- **Type consistency:** Task 1 定义的 `ConversationReimbursementContext` 被 Task 2–4 复用；`turnId`、`channel`、`actorId`、`actorRole` 命名一致。
- **Review focus:** 五项高风险输入均映射到对应任务测试。
- **Proportion:** 计划约束接口、文件、测试和命令，不复述实现代码。
