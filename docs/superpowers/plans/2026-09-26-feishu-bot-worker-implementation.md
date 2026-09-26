# 飞书报销机器人 Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已完成飞书 OAuth 绑定的员工可在飞书单聊或 @机器人群聊中创建、续办报销草稿并上传票据，同时始终在 Web 完成字段确认与提交。

**Architecture:** 新增持久化入站事件与会话绑定，由常驻长连接 Worker 快速记录飞书事件后异步处理。Worker 通过受控飞书客户端重新读取消息或附件，并调用既有创建草稿、上传、OCR、Agent 与校验用例；回复只包含进度与 Web 工作台链接。

**Tech Stack:** Next.js 15、TypeScript、Prisma 7/PostgreSQL、MinIO/S3、ClamAV、PaddleOCR、Zod、Vitest、Playwright、`@larksuiteoapi/node-sdk`、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-09-26-feishu-bot-worker-design.md`

## Global Constraints

- 使用飞书长连接 Worker；不在浏览器请求或 Next.js Route Handler 中维持长连接。
- 群聊仅响应明确 @机器人的消息；未 @ 消息不持久化正文、不创建草稿、不回复。
- 未绑定 `Employee.feishuUserId` 的 `open_id` 只收到 OAuth 登录链接，不自动创建员工或草稿。
- 每个 `employeeId + chatId` 仅绑定一张当前草稿；`新建报销` 替换绑定，`查看当前草稿` 仅返回链接。
- 飞书仅可创建/续办草稿、上传与查询；字段建议确认、删除和提交只能留在 Web。
- 事件/消息重复投递最多产生一次业务写入；业务成功后飞书回复失败不得回滚草稿或附件。
- 不在数据库普通字段、日志、模型上下文或飞书回复中保存 App Secret、access token、附件字节、完整原始消息、对象键或 OCR 原文。
- 附件必须复用既有 `uploadReceipt`、`extractReceipt`、安全扫描、MinIO、OCR 与重复票校验，而非渠道旁路实现。

## Review Focus

- 同一 `message_id` 使用不同 `event_id` 重推时，第二次不得重复建草稿或票据；Task 1 的仓储测试覆盖。
- 群消息含相似文本但未提及 `FEISHU_BOT_OPEN_ID` 时必须完全忽略；Task 3 的应用用例测试覆盖。
- 未绑定 `open_id` 携带合规附件时，回复登录链接且不下载、不存储附件；Task 3 的测试覆盖。
- 飞书资源下载返回错误、非 JPEG/PNG/PDF、超过 20MB 或与声明类型签名不符时，状态可重试且既有草稿保持；Task 4 的测试覆盖。
- 草稿在 Worker 处理期间被 Web 更新时，Worker 不覆盖字段并回复最新工作台链接；Task 4 的冲突测试覆盖。

---

## File Structure

- `prisma/schema.prisma`：入站事件与飞书会话模型及状态枚举。
- `prisma/migrations/20260926000000_add_feishu_bot_worker/migration.sql`：数据库表、唯一约束和索引。
- `src/domain/feishu-bot.ts`：规范化入站消息、附件、命令和回复类型。
- `src/infrastructure/prisma/feishu-bot-repository.ts`：事件去重、状态领取、会话绑定和员工映射的 Prisma 实现。
- `src/infrastructure/feishu/feishu-bot-client.ts`：飞书应用令牌、读取消息/附件、回复消息和 SDK 长连接适配器。
- `src/application/process-feishu-event.ts`：身份、群 @、命令、会话、文本 Agent 与附件流水线编排。
- `src/worker/feishu-bot.ts`：事件接收、快速落库、待处理轮询、重试与优雅退出。
- `src/server/config.ts`：机器人启用、公共 Web 地址和机器人 `open_id` 的显式配置校验。
- `package.json`、`Dockerfile`、`docker-compose.yml`：Worker 命令与部署服务。
- `.env.example`、`README.md`、`docs/operations.md`、`docs/feishu-integration.md`：配置、开放平台设置、部署和故障恢复说明。

### Task 1: 持久化入站事件与会话绑定

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260926000000_add_feishu_bot_worker/migration.sql`
- Create: `src/infrastructure/prisma/feishu-bot-repository.ts`
- Create: `tests/integration/feishu-bot-repository.test.ts`

**Interfaces:**
- Produces `FeishuBotRepository`：`recordInbound(input)`, `claimNextPending()`, `markProcessed(id)`, `markRetryableFailure(id, code)`, `findEmployeeByOpenId(openId)`, `getConversation(employeeId, chatId)`, `setConversation(employeeId, chatId, claimId)`。
- `recordInbound` 返回 `{ id: string; shouldProcess: boolean }`，以 `eventId` 和非空 `messageId` 去重；`claimNextPending` 原子领取一条 `PENDING | RETRYABLE` 记录并变为 `PROCESSING`。
- Consumed by Tasks 3 and 5.

- [ ] **Step 1: 写入仓储集成测试**

覆盖同一事件、不同事件但相同消息、会话替换、首次/重复领取、重试状态和不同员工同会话 ID 的隔离。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/integration/feishu-bot-repository.test.ts`

Expected: FAIL，因为模型和 `FeishuBotRepository` 尚不存在。

- [ ] **Step 3: 扩展 Prisma 模型和迁移**

新增 `InboundChannelEventStatus`（`PENDING`、`PROCESSING`、`PROCESSED`、`RETRYABLE`）以及 `InboundChannelEvent`、`FeishuConversation`。事件表只保存渠道、事件 ID、消息 ID、消息类型、聊天 ID、发送者 open ID、状态、最小错误码、关联草稿与时间；不保存原始正文或资源 key。为事件 ID、消息 ID、状态/接收时间和 `employeeId + chatId` 创建支持轮询与幂等的唯一约束/索引。

- [ ] **Step 4: 实现 `FeishuBotRepository`**

以 Prisma 事务完成 `recordInbound` 的唯一冲突恢复，以及 `claimNextPending` 的条件更新。查询到的事件只暴露后续处理所需的安全元数据；Worker 处理时必须通过飞书 API 重新读取消息内容。

- [ ] **Step 5: 生成 Prisma Client 并运行测试**

Run: `npx prisma generate --config prisma7.config.ts && npm test -- tests/integration/feishu-bot-repository.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add prisma src/infrastructure/prisma tests/integration
git commit -m "feat: persist Feishu inbound events"
```

### Task 2: 飞书机器人配置与基础客户端

**Files:**
- Modify: `src/server/config.ts`
- Create: `src/domain/feishu-bot.ts`
- Create: `src/infrastructure/feishu/feishu-bot-client.ts`
- Create: `tests/unit/server/feishu-bot-config.test.ts`
- Create: `tests/unit/infrastructure/feishu-bot-client.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `FeishuBotConfig`：`{ appId, appSecret, botOpenId, publicAppUrl, eventDelivery: "long_connection" }`。
- Produces `FeishuBotClient`：`getMessage(messageId)`, `downloadResource(messageId, fileKey, type)`, `replyText(messageId, text)`, `replyCard(messageId, card)`。
- `getMessage` returns normalized `FeishuInboundMessage`; `downloadResource` returns `{ bytes: Uint8Array; filename: string; mimeType: string }`。
- Consumed by Tasks 3–5.

- [ ] **Step 1: 写入配置与客户端失败测试**

配置测试断言：未启用机器人时不要求机器人变量；启用时缺少 `FEISHU_BOT_OPEN_ID` 或 `APP_PUBLIC_URL` 必须启动失败；生产环境必须有完整凭据。客户端测试使用注入 fetch，断言 Bearer token 仅放在请求头、资源下载使用消息资源接口、回复失败不会泄露飞书响应体或凭据。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/server/feishu-bot-config.test.ts tests/unit/infrastructure/feishu-bot-client.test.ts`

Expected: FAIL，因为机器人配置、领域类型和客户端尚不存在。

- [ ] **Step 3: 增加依赖和显式配置解析**

在 `package.json` 增加 `@larksuiteoapi/node-sdk` 及运行 TypeScript Worker 所需的 `tsx`。在 `loadConfig` 中保留现有 OAuth 配置，新增可选 `feishuBot`；只有 `FEISHU_BOT_ENABLED="true"` 才启用，且只允许 `FEISHU_EVENT_DELIVERY="long_connection"`。

- [ ] **Step 4: 实现安全的飞书客户端**

实现应用 tenant token 获取与缓存、消息读取、`message_id + file_key` 资源下载和回复。使用 Zod 严格解析飞书响应，转换为渠道领域类型；异常只暴露 `UNAVAILABLE`、`UNAUTHORIZED`、`RESOURCE_NOT_FOUND`、`INVALID_RESPONSE` 等安全分类。长连接 SDK 初始化在 Task 5，不能隐藏在 HTTP 客户端中。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test -- tests/unit/server/feishu-bot-config.test.ts tests/unit/infrastructure/feishu-bot-client.test.ts && npx tsc --noEmit`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/server/config.ts src/domain src/infrastructure/feishu tests/unit
git commit -m "feat: add Feishu bot configuration and client"
```

### Task 3: 文本、身份与会话草稿编排

**Files:**
- Create: `src/application/process-feishu-event.ts`
- Create: `tests/unit/application/process-feishu-event.test.ts`
- Modify: `src/application/create-claim-draft.ts`（仅在需要暴露已有依赖类型时）

**Interfaces:**
- Produces `processFeishuEvent(input: { eventId: string }, deps: ProcessFeishuEventDeps): Promise<FeishuProcessingResult>`。
- Consumes Task 1 的 `FeishuBotRepository` 和 Task 2 的 `FeishuBotClient`，以及现有 `createClaimDraft`、`runAgentTurn` 依赖。
- `FeishuProcessingResult` 为 `IGNORED | LOGIN_REQUIRED | CLAIM_LINKED | AGENT_REPLIED | ATTACHMENT_QUEUED | RETRYABLE_FAILURE`；Task 5 按此更新事件状态并回复。

- [ ] **Step 1: 写入应用层失败测试**

使用内存仓储/客户端覆盖：未 @ 的群消息忽略；未绑定员工只回复登录链接；首次文本创建草稿并会话绑定；`新建报销` 替换绑定；`查看当前草稿` 返回绑定草稿链接；普通文本调用 Agent 且只回复建议摘要与 Web 链接。断言不会调用字段更新、建议确认或提交依赖。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/application/process-feishu-event.test.ts`

Expected: FAIL，因为编排用例不存在。

- [ ] **Step 3: 实现命令解析和安全路由**

在 `src/domain/feishu-bot.ts` 将规范化文本只识别为 `NEW_CLAIM`、`VIEW_CURRENT_CLAIM` 或 `CHAT`。群消息要求 mentions 中含 `botOpenId`；单聊不要求 @。未绑定员工构造 `${publicAppUrl}/api/auth/feishu/login`，不读取或下载附件。

- [ ] **Step 4: 实现 `processFeishuEvent` 文本分支**

事件处理从 Task 1 读取安全元数据并由 Task 2 拉取消息。草稿创建必须调用 `createClaimDraft`；Agent 文本必须调用 `runAgentTurn` 并保留其模型白名单、草稿归属、版本和审计语义。飞书回复不包含建议 ID、字段写入 URL 或确认按钮，只提供工作台链接。

- [ ] **Step 5: 运行应用测试**

Run: `npm test -- tests/unit/application/process-feishu-event.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/domain/feishu-bot.ts src/application/process-feishu-event.ts tests/unit/application
git commit -m "feat: route Feishu text messages to claims"
```

### Task 4: 附件复用、OCR 与可恢复处理

**Files:**
- Modify: `src/application/process-feishu-event.ts`
- Modify: `tests/unit/application/process-feishu-event.test.ts`
- Create: `tests/integration/feishu-bot-attachment.test.ts`

**Interfaces:**
- Extends `ProcessFeishuEventDeps` with `uploadReceipt`, `extractReceipt` 和既有对象存储、扫描、OCR Provider 依赖。
- 附件成功结果包含 `claimId`、`receiptId`、`receiptStatus` 和可安全展示的文件名；下载或处理失败返回安全错误分类而非原始 provider 响应。
- Consumed by Task 5。

- [ ] **Step 1: 扩展失败测试**

覆盖已绑定员工首次附件自动建草稿、图片/PDF/文件资源下载后调用 `uploadReceipt` 与 `extractReceipt`、20MB 外附件/不支持 MIME/签名不匹配的拒绝、下载失败、OCR 失败和 Web 并发更新造成的版本冲突。断言未绑定员工不下载附件，失败保留草稿而不产生伪造费用。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-attachment.test.ts`

Expected: FAIL，因为附件分支尚未编排。

- [ ] **Step 3: 实现附件处理分支**

从消息内容解析 `image_key` 或 `file_key`，调用 `downloadResource` 后将返回字节原样交给 `uploadReceipt`。上传成功后调用 `extractReceipt`；复用现有 20MB、JPEG/PNG/PDF、签名、PDF 页数、ClamAV、MinIO、重复票与 OCR 实现。捕获安全分类错误并生成“可重试/请在工作台处理”的简短回复，不泄露对象键、OCR 原文或 provider 响应。

- [ ] **Step 4: 运行附件测试与现有上传回归**

Run: `npm test -- tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-attachment.test.ts tests/unit/application/upload-receipt.test.ts tests/unit/application/extract-receipt.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/application/process-feishu-event.ts tests/unit/application tests/integration
git commit -m "feat: process Feishu receipt attachments"
```

### Task 5: 长连接 Worker、轮询与回复重试

**Files:**
- Create: `src/worker/feishu-bot.ts`
- Create: `src/worker/feishu-bot-runtime.ts`
- Create: `tests/unit/worker/feishu-bot-runtime.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces CLI script `npm run feishu:worker`，仅在 `FEISHU_BOT_ENABLED=true` 时启动。
- `createFeishuBotRuntime(deps)` 暴露 `onEvent(event)`, `drainOnce()` 和 `stop()`，将 SDK 事件写入 Task 1 仓储并由 `drainOnce` 调用 Task 3/4 用例。
- Consumes Tasks 1–4。

- [ ] **Step 1: 写入 Worker Runtime 失败测试**

覆盖 SDK 事件回调只落库、重复回调只落一次、`drainOnce` 成功后标记 `PROCESSED`、可重试错误标记 `RETRYABLE`、飞书回复失败不改变业务成功状态、优雅退出停止轮询且断开连接。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/worker/feishu-bot-runtime.test.ts`

Expected: FAIL，因为 Worker Runtime 尚不存在。

- [ ] **Step 3: 实现常驻 Worker**

使用飞书 Node SDK 建立长连接并仅订阅 `im.message.receive_v1`。回调只规范化并调用 `recordInbound`，随后立即确认；运行时按固定短间隔领取事件并处理。启动时恢复 `PENDING` 和 `RETRYABLE` 事件，收到 `SIGINT`/`SIGTERM` 时停止领取新事件、完成当前安全操作、释放 Prisma 和 SDK 连接。

- [ ] **Step 4: 实现安全回复策略**

将 Task 3/4 结果映射为文本或交互卡片：登录链接、附件处理中/完成/失败、待补项与工作台链接。回复失败只使事件回复字段进入可重试状态；禁止向飞书发送完整异常、建议 ID、对象键、凭据或提交动作。

- [ ] **Step 5: 运行 Worker 测试**

Run: `npm test -- tests/unit/worker/feishu-bot-runtime.test.ts && npx tsc --noEmit`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/worker package.json package-lock.json tests/unit/worker
git commit -m "feat: run Feishu bot long connection worker"
```

### Task 6: Docker、环境与运维文档

**Files:**
- Create: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/feishu-integration.md`
- Create: `tests/unit/server/feishu-worker-environment.test.ts`

**Interfaces:**
- Produces `web` 和 `feishu-bot-worker` 两个同镜像服务；Web 运行 Next，Worker 运行 `npm run feishu:worker`。
- 两服务使用同一数据库、MinIO、ClamAV、OCR 与飞书配置；Worker 仅需出网访问飞书，`APP_PUBLIC_URL` 必须是员工可访问的 HTTPS Web 地址。

- [ ] **Step 1: 写入环境验证失败测试**

断言生产 Worker 缺失 `FEISHU_BOT_ENABLED` 所需凭据、`FEISHU_BOT_OPEN_ID`、`APP_PUBLIC_URL` 或依赖服务地址时启动失败；禁用机器人时 Web 仍可仅以现有 OAuth 配置启动。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/server/feishu-worker-environment.test.ts`

Expected: FAIL，因为 Worker 环境验证和部署配置尚不存在。

- [ ] **Step 3: 创建生产镜像和 Compose 服务**

创建一次构建、两个运行命令的 `Dockerfile`。扩展 Compose：新增 `web`、`feishu-bot-worker` 及健康依赖；不把 App Secret 或本地账号密码硬编码进镜像或 Compose。Worker 使用 `restart: unless-stopped`，并与 PostgreSQL、MinIO、ClamAV、OCR 共享受控网络配置。

- [ ] **Step 4: 补充配置和运维文档**

说明飞书开放平台中的机器人能力、最小权限、长连接事件订阅、测试企业发布步骤、Worker 启停、查看安全日志和失败重试。明确本地可用长连接测试，但飞书卡片中的工作台链接在多人/移动端需要公网 HTTPS `APP_PUBLIC_URL`。

- [ ] **Step 5: 运行环境测试与 Compose 配置检查**

Run: `npm test -- tests/unit/server/feishu-worker-environment.test.ts && docker compose config`

Expected: PASS，且 Compose 输出不包含密钥值。

- [ ] **Step 6: 提交**

```bash
git add Dockerfile docker-compose.yml .env.example README.md docs src/server tests/unit/server
git commit -m "docs: document Feishu bot deployment"
```

### Task 7: 跨渠道回归、真实飞书测试清单与发布门禁

**Files:**
- Create: `tests/integration/feishu-bot-worker.test.ts`
- Modify: `tests/e2e/agent-confirmation.spec.ts`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes Tasks 1–6，通过伪造飞书客户端/SDK 运行完整“事件落库 → Worker 领取 → 既有用例 → 回复”流程。
- Produces可重复的本地自动化证据和人工测试企业清单，不使用真实 App Secret 或真实飞书附件作为自动测试输入。

- [ ] **Step 1: 写入端到端应用边界失败测试**

集成测试覆盖：首次绑定员工发送票据、同一消息重推、群聊 @与未@、新建/查看命令、Web 修改后的冲突、回复失败重试。浏览器测试仅验证 Web 链接落在正确草稿工作台，以及仍无飞书侧确认/提交入口。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/integration/feishu-bot-worker.test.ts && npm run test:e2e -- tests/e2e/agent-confirmation.spec.ts`

Expected: FAIL，直到完整 Worker 与测试桩接通。

- [ ] **Step 3: 实现最小测试桩并更新测试企业检查清单**

测试桩只模拟 SDK 输入/输出与资源下载，真实业务必须走 Task 3/4 服务。运维文档加入人工清单：测试企业发布、单聊文本、群聊 @、图片/PDF、未绑定用户、重复投递、Worker 重启、OCR/模型失败及 Web 确认/提交边界。

- [ ] **Step 4: 运行完整质量门禁**

Run: `npx prisma generate --config prisma7.config.ts && npx tsc --noEmit && npm run lint && npm test && npm run test:e2e -- --workers=1 && npm run build && docker compose config`

Expected: 全部通过；执行生产构建前停止本地 Next 开发服务，避免 `.next` 目录冲突。

- [ ] **Step 5: 提交**

```bash
git add tests docs/operations.md
git commit -m "test: cover Feishu bot worker flow"
```

## Spec Coverage Self-Review

- 渠道 Worker、长连接与 Docker 服务：Tasks 2、5、6。
- 事件/消息幂等、持久化、恢复与回复失败：Tasks 1、5、7。
- OAuth 身份绑定、群聊 @限制、会话草稿路由与命令：Task 3。
- 附件下载及既有安全/OCR/重复票复用：Task 4。
- Web-only 确认、删除与提交边界：Tasks 3、5、7。
- 配置、密钥保护、运维与测试企业上线：Tasks 2、6、7。

所有规格要求均有对应任务；Review Focus 中五类风险分别由 Tasks 1、3、3、4、4 的测试固定。
