# Agent Go 工具网关硬切换设计

## 背景与目标

报销 Agent 当前已经拥有 `services/agent` 中的受控工具网关：工具调用携带员工、角色、渠道、会话、工具调用 ID 与幂等键，并通过签名的 Agent JWT 和服务密钥调用 Go 报销 API。该链路已覆盖创建草稿、上传、读取工作台、更新报销事由、校验和提交。

但 Web 私有会话路由与飞书机器人仍保留 `Go 工具可用则调用，否则直接 Prisma/Next.js 用例` 的双路径。双路径会让相同 Agent 对话在不同部署配置下写入不同领域实现，削弱审计、一致性与后续 IM 扩展能力。

本期目标是让 **所有 Agent 发起的报销领域读写只能经过 Go 工具网关**。Agent 仍拥有会话、模型调用、政策检索、工具调用账本与渠道投递；Go 服务唯一拥有报销单、票据、OCR、校验、提交、审计与领域事件。

## 已选方案与取舍

### 方案 A：Go 工具网关硬切换（已选）

Web 对话与飞书机器人都创建同一套 `ReimbursementToolGateway` + `ReimbursementApiClient`。删除 Node/Prisma 的报销办理兜底；所需环境变量缺失时进程启动失败或入口返回明确的配置不可用错误，而不允许静默切回旧路径。

- 优点：单一业务事实源、权限与审计一致、未来渠道只需适配工具层。
- 代价：必须补齐 Go API 的工具契约和端到端测试，不能依赖旧路径救火。

### 方案 B：默认 Go、保留 Feature Flag 回退（未选）

迁移初期允许通过环境变量退回 Prisma 实现。它降低短期回滚门槛，但会长期保留分叉业务行为和数据一致性风险，不符合“彻底收敛”目标。

### 方案 C：直接暴露 MCP Server（未选）

将工具包装为 MCP 可便于外部 Agent 发现，但当前内部工具契约尚需稳定；先引入 MCP 会增加协议、认证和部署复杂度。工具网关稳定后可作为单独适配层实现 MCP，不改变本期边界。

## 范围

### 纳入

- Web 私有对话文字入口：`app/api/conversations/private/messages/route.ts`。
- Web 私有对话附件入口：`app/api/conversations/private/attachments/route.ts`。
- 飞书机器人入口：`src/worker/feishu-bot.ts`。
- Agent 工具端口、HTTP 适配器、调用结果账本、Go API 契约与对应测试。
- Agent JWT、服务密钥、来源渠道、会话和幂等键在链路中的统一传递。

### 不纳入

- 迁移普通 Web 报销工作台的 React/Go API 调用；它不是 Agent 入口。
- 迁移政策知识库、会话历史、模型 Provider 或飞书消息接收的持久化，它们继续由 Agent 服务负责。
- 引入 MCP Server、可自由决定写操作的模型循环、自动提交或新模型供应商。
- 删除旧 Next.js 报销页面/API；本期只移除它们被 Agent 办理路径调用的可能。

## 目标架构

```text
Web 对话 / 飞书机器人
          |
          v
runConversationTurn（意图、澄清、会话状态）
          |
          v
ConversationReimbursementTools
          |
          v
ReimbursementToolGateway（参数白名单、调用去重、结果账本）
          |
          v
ReimbursementApiClient（Agent JWT + Service Key + Idempotency-Key）
          |
          v
Go Reimbursement API（领域权限、版本、审计、Outbox）
```

`agent-event-worker` 已经使用 `ReimbursementApiClient` 消费 Go 领域事件；本期保留该模式，并使会话办理路径与它一致。

## 工具契约

继续使用下列八个内部工具名，不让模型直接构造 HTTP 请求：

| 工具 | 领域动作 | 写入保护 |
| --- | --- | --- |
| `create_claim_draft` | 创建草稿 | 幂等键、员工归属 |
| `create_upload_session` | 申请受限上传 URL | 幂等键、草稿归属、文件元数据校验 |
| `finalize_receipt_upload` | 完成上传并进入 Go OCR 流程 | 幂等键、安全扫描、Outbox |
| `get_claim_workbench` | 获取当前草稿与票据状态 | 员工归属 |
| `update_claim_fields` | 更新允许的报销字段 | 当前版本、字段白名单 |
| `get_claim_validation` | 读取提交校验结果 | 员工归属 |
| `request_submission_confirmation` | 生成提交确认摘要和令牌 | 当前版本、服务端重新校验 |
| `submit_claim` | 提交报销单 | 确认令牌、幂等键、事务审计 |

Agent 模型只能产生受 `runConversationTurn` 允许的高层决定；工具参数由会话状态和确定性适配器构造。即使模型输出异常，也不能越过字段白名单、版本校验或显式“确认提交”。

## 身份、幂等与失败语义

- Web 会话使用服务端会话解析出的员工 ID 与角色；飞书消息使用已验证的 `open_id` 解析出的员工投影。客户端传入的角色一律不可信。
- Agent HTTP 请求必须同时包含短期、`channel=agent` 的签名 JWT 和 `X-Agent-Service-Key`；Go API 验证员工仍处于活动状态。
- 飞书工具调用 ID 由入站飞书消息 ID、工具名组成。Web 入口为每个用户回合生成并持久化稳定的 `turnId`，重试必须携带同一 `turnId`；同一回合的多个工具以工具名作为后缀区分。
- `AgentToolCall` 仅缓存已经成功完成的工具结果，避免消息重投造成重复建单/提交；Go API 的 `Idempotency-Key` 是第二道保护。
- Go API 的业务错误映射为安全、可恢复的 Agent 文案；Go API 不可用、认证失败或配置缺失绝不回退 Prisma，分别记录 `tool.unavailable`、`tool.unauthorized` 或 `tool.configuration_missing`。

## 实现边界与关键改动

1. 提供共享的 Agent 报销工具运行时工厂，供 Web 对话路由与飞书 Worker 注入；该工厂强制校验 `REIMBURSEMENT_API_URL`、`REIMBURSEMENT_AGENT_SERVICE_KEY` 和 `REIMBURSEMENT_AUTH_HS256_SECRET`。
2. 将 `ConversationContext.channel` 从仅 `FEISHU` 扩展为 `WEB | FEISHU`，并为 Web 回合实现稳定工具调用 ID。
3. Web 文字与附件路由移除 `PrismaClaimRepository`、`PrismaReceiptRepository`、`PrismaAsyncJobRepository`、旧上传/OCR/提交用例的依赖；仍保留会话仓储、模型和政策检索依赖。
4. 飞书 Worker 删除 `REIMBURSEMENT_AGENT_MODE` 分支、Go 工具为空时的 Prisma 兜底，以及仅为旧路径准备的报销仓储/对象存储/OCR 依赖。
5. 上传附件仍由 Agent 获取字节并 PUT 到 Go 生成的预签名上传 URL；扫描、对象归档、OCR 投递与票据审计由 Go `finalize_receipt_upload` 负责。Node 不再单独扫描或直接写对象。
6. 若八个工具返回的字段不足以支撑当前对话，优先扩展 Go API 与工具契约；不得重新引入 Prisma 领域写入。

## 验收标准

1. Web 对话和飞书对话均能完成：开始报销、补充事由、上传票据、读取校验摘要、明确确认提交。
2. Agent 入口源文件不再导入 Prisma 报销单/票据/异步任务仓储或旧的报销领域写用例；仅会话、政策和 Agent 调用账本仍可使用 Prisma。
3. 同一 Web `turnId` 或飞书消息重投不重复创建草稿、上传会话或提交记录。
4. Go API 故障或 Agent 配置缺失时，Agent 返回安全错误且不会写入旧数据库路径。
5. Go API 收到 Web JWT 冒充的 Agent 请求、错误服务密钥或非活动员工时均拒绝。
6. 每一次成功领域写操作都同时可在 Agent 工具账本与 Go 领域审计/Outbox 中追溯。
7. 覆盖 Tool Gateway、Web 路由、飞书运行时和 Go HTTP 授权的自动化测试；完成一条 Web 与一条飞书手工验收链路。

## 迁移与回滚

这是代码层硬切换，不设计旧 Prisma 运行时回退。发布前必须先让 Go API、NATS、对象存储和 Agent 必要密钥就绪；发布异常时回滚到上一版整体应用镜像/部署版本，而不是在运行中切换到另一套业务实现。不会迁移会话或报销数据，因为 Agent 继续使用既有会话记录，报销领域事实已经由 Go 服务承载。
