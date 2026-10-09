# React + Go 报销平台重构设计

## 背景与结论

当前系统是一个可运行的 AI 报销原型：Next.js 同时提供页面、HTTP API、飞书 OAuth、报销领域服务和 Agent 编排；Prisma/PostgreSQL 同时保存报销、Agent、知识库与任务数据。它已经验证了员工从上传票据、OCR 识别、补充信息到提交报销单的主链路，但服务边界不适合后续以 React + Go 作为长期生产形态。

本设计采用**渐进式绞杀迁移**：新建 Go 报销核心服务和 React 单页应用，保留并独立现有 TypeScript Agent、OCR 与知识服务。每个可迁移能力在一个明确的切换点只保留一个写入方；Agent 从直接使用 Prisma Repository 改为通过受控工具调用 Go API。最终 Go 是报销业务事实源，Agent 是多渠道智能入口，React 是普通 Web 入口。

## 目标

1. 将报销单、票据、费用项、规则校验、提交、人工复核和业务审计的读写收敛到 Go 报销核心服务。
2. 建立 React 前端，所有业务调用均通过版本化 Go API，不依赖 Agent 可用性。
3. 将飞书/Web Agent、会话、RAG、模型调用和渠道事件迁为独立 Agent 服务；它不得直接连接报销领域表。
4. 建立幂等、安全的工具合同，使 Agent 可以代表已认证员工创建草稿、上传票据、补字段、校验和提交。
5. 用 PostgreSQL Outbox 和 NATS JetStream 传递 OCR、复核、提交等领域事件，避免同步跨服务回调和跨库轮询。
6. 保留现有的 MinIO、ClamAV、PaddleOCR、BGE-M3、Loki/Alloy/Grafana/Alertmanager 能力，并将其改为通过服务边界协作。

## 非目标

- 本期不重做 OCR 模型、向量模型或飞书应用能力。
- 本期不把模型判断作为报销规则最终裁决。
- 本期不引入多租户计费、支付、ERP 凭证或完整审批流；这些将在报销核心稳定后增量实现。
- 不进行一次性停机重写，不要求当前 Next.js 产品在迁移期间下线。
- MCP 不替代 Go API；MCP 只是 Agent 使用业务 API 的标准化适配协议。

## 现状盘点

截至本设计创建时，仓库包含 33 个 Next.js API Route、27 个应用服务和 10 个 Prisma Repository。已有的领域模块覆盖 `ClaimDraft`、`Receipt`、`ExpenseItem`、校验、政策规则、提交快照、异步任务和人工复核；这些逻辑是 Go 实现的行为依据和回归测试来源。

目前 PostgreSQL 表将下列两类状态混放在 Prisma Schema 中：

| 类型 | 当前模型示例 | 目标归属 |
|---|---|---|
| 报销核心 | `ClaimDraft`、`Receipt`、`ExpenseItem`、`ValidationResult`、`SubmissionSnapshot`、`AuditEvent` | Go 报销服务 |
| 政策裁决 | `PolicyVersion`、`PolicyRule`、`PolicyAuditEvent` | Go 报销服务 |
| 任务与复核 | `AsyncJob`、`ReviewCase` | Go 报销服务 |
| Agent 状态 | `AgentConversation`、`AgentMessage`、`ReimbursementIntake`、`AgentFieldProposal` | Agent 服务 |
| 渠道状态 | `InboundChannelEvent`、旧 `FeishuConversation`、通知投递状态 | Agent 服务 |
| 知识库 | `PolicySource`、`PolicyDocumentSnapshot`、`PolicyChunk` | Agent/知识服务 |

`Employee` 的员工主数据和飞书账号映射由 Go 身份边界管理。Agent 只缓存必需的稳定员工 ID 与飞书 `open_id` 映射，不自行授予业务角色。

## 目标服务架构

```text
React SPA
    │ HTTPS /api/v1
    ▼
Go Reimbursement API ───── PostgreSQL: reimbursement schema
    │                       MinIO / ClamAV / OCR adapter
    │
    ├──── PostgreSQL Outbox ──── NATS JetStream ──── Go workers
    │                                      │
    │                                      ▼
    └──── Internal Tool API ◀──── Agent Service ─── PostgreSQL: agent schema
                                       │
                              Feishu / Web chat / RAG / LLM
```

所有服务部署在私有容器网络。仅 React 的公开入口和经反向代理保护的 Go API 对员工可见；NATS、PostgreSQL、MinIO、OCR、Agent 内部工具端口均不直接暴露到公网。

### 1. React Web (`apps/web`)

- 技术栈：React 19、TypeScript、Vite、React Router、TanStack Query。
- 只承载 UI 状态、表单输入、文件选择和 API 展示；不含领域裁决、模型提示词或数据库连接。
- 通过 OpenAPI 生成的 TypeScript Client 调用 Go 的 `/api/v1`。
- 第一批页面迁移为：报销单列表、草稿工作台、附件上传、校验与提交确认。后台规则、知识源和复核页面在核心能力切换后迁移。

### 2. Go 报销核心 (`services/reimbursement-api`)

- 技术栈：Go 1.27.1、`chi`、`pgx/v5`、`sqlc`、`oapi-codegen`、PostgreSQL 16、`goose` 数据库迁移。
- 使用领域包与应用服务分层，不使用会隐式生成查询的 ORM；`sqlc` 是数据库访问的唯一生成方式。
- 暴露 OpenAPI 3.1 文档，REST 是 React、Agent Tool Gateway 和未来外部系统的唯一同步业务合同。
- 所有可变请求要求 `Idempotency-Key`；成功响应保存请求摘要、状态码和结果，重复请求返回原结果而不重复建单或提交。
- 核心业务状态机由 Go 执行：`DRAFT → PROCESSING / NEEDS_INFORMATION / AWAITING_CONFIRMATION → SUBMITTED`。不合法跃迁返回稳定业务错误码。

### 3. Agent 服务 (`services/agent`)

- 继续使用 TypeScript/Node，复用现有飞书长连接、模型、RAG、会话总结、附件下载和告警日志能力。
- 拥有会话、渠道事件去重、意图、Agent 工具调用记录和检索历史；不拥有 `Claim`、`Receipt` 或政策规则写模型。
- 将当前 Prisma 领域 Repository 依赖替换为 `ReimbursementPort`。该 Port 的生产实现是 Tool Gateway/Go OpenAPI Client；测试使用 Fake Port。
- LLM 只能输出回复、澄清问题或工具调用意图。所有工具参数、权限、版本、业务规则与提交确认由 Go 服务验证。

### 4. Tool Gateway / MCP

Tool Gateway 以 TypeScript 模块随 Agent 服务首次部署，并提供同一套 typed tool contract；未来可将该模块作为独立 MCP Server 发布，而不改变 Go API。

第一批工具固定为：

```text
create_claim_draft
create_upload_session
finalize_receipt_upload
get_claim_workbench
update_claim_fields
get_claim_validation
request_submission_confirmation
submit_claim
```

工具必须携带 `actorEmployeeId`、`channel`、`conversationId`、`toolCallId` 和 `Idempotency-Key`。Tool Gateway 使用服务身份调用 Go 内部接口；Go 根据受委托员工身份重新进行资源级鉴权，不能信任浏览器或模型给出的员工 ID。

## 关键合同

### 外部员工 API

```text
POST   /api/v1/claims
GET    /api/v1/claims?status=&cursor=
GET    /api/v1/claims/{claimId}
PATCH  /api/v1/claims/{claimId}
DELETE /api/v1/claims/{claimId}                 # 仅 DRAFT
POST   /api/v1/claims/{claimId}/uploads
POST   /api/v1/claims/{claimId}/receipts
DELETE /api/v1/claims/{claimId}/receipts/{receiptId} # 仅 DRAFT
GET    /api/v1/claims/{claimId}/validation
POST   /api/v1/claims/{claimId}/submission-requests
POST   /api/v1/claims/{claimId}/submit
```

上传采用两步协议：Go 先返回受限的 MinIO 预签名上传会话；客户端或 Agent 上传后调用 `finalize_receipt_upload`。Go 校验文件元数据、触发病毒扫描、创建 `Receipt` 与 OCR 任务，并写入同一事务 Outbox。Agent 不再直接将对象键写入数据库。

### 内部受委托调用

Agent 使用单独的内部路由组调用相同应用服务。每个请求含短期委托 JWT，至少包含：`sub`（员工 ID）、`aud=reimbursement-api`、`channel`、`conversation_id`、`tool_call_id`、过期时间和不可重放的 JWT ID。Go 校验 Agent 服务身份、JWT 签名、受委托员工状态和资源所有权，并在业务审计中记录 `actor_type=AGENT`、员工 ID、渠道和工具调用 ID。

### 错误模型

Go API 返回稳定 `code`、安全 `message`、`requestId`：

```text
AUTHENTICATION_REQUIRED
FORBIDDEN
CLAIM_NOT_FOUND
CLAIM_NOT_DRAFT
VERSION_CONFLICT
IDEMPOTENCY_CONFLICT
RECEIPT_INVALID
VALIDATION_BLOCKED
SUBMISSION_CONFIRMATION_INVALID
OCR_PENDING
```

Agent 将这些转换成用户可理解的话术，但不吞掉 `requestId`；该 ID 仅用于受控支持渠道和日志关联。

## 数据、事件与一致性

### 数据库边界

使用同一个 PostgreSQL 集群以降低运维成本，但通过两个逻辑 Schema 和独立数据库账号隔离：

```text
reimbursement.*  仅 Go 报销服务可写，Agent 账号无权限
agent.*          仅 Agent 服务可写，Go 账号无权限
```

跨服务只保存不带外键的不可变字符串标识，例如 `claim_id`、`employee_id` 和 `event_id`。跨 Schema 不创建外键、触发器或共享写事务。

### Outbox 与事件

在报销写事务内同时写业务数据、审计记录与 `reimbursement.outbox_event`。Outbox Publisher 以 `SELECT … FOR UPDATE SKIP LOCKED` 领取未发布记录，发布到 NATS JetStream，再标记发布状态；消费者必须按 `event_id` 去重。

首批事件：

```text
claim.created.v1
receipt.uploaded.v1
receipt.extraction.completed.v1
receipt.extraction.review_required.v1
claim.validation.updated.v1
claim.submitted.v1
claim.deleted.v1
```

Go OCR Worker 使用现有 PaddleOCR HTTP 服务，接收结果后更新 Go 领域数据并发布事件。Agent 订阅 OCR 完成事件，读取脱敏工作台数据，再向飞书或 Web 对话发送识别结果、缺失项或工作台链接。

### 政策边界

Go 服务拥有可执行的政策版本、规则和最终校验；提交时重新校验并写入不可变提交快照。Agent 知识服务拥有飞书文档同步、切片、向量检索和解释性回答。RAG 命中可以解释原因，永远不能覆盖 Go 的 `VALIDATION_BLOCKED` 结果。

## 身份、权限与审计

1. Go 服务是员工、角色和飞书账号映射的唯一权威来源。
2. React 使用 Go 的 HttpOnly 会话或企业 IdP OIDC Token，不在浏览器保存长期访问令牌。
3. 飞书私聊用户第一次进入时，Agent 调 Go 身份接口完成 `open_id → employee_id` 解析；未绑定时只返回登录/绑定引导。
4. Agent 以员工身份受委托操作，不能使用管理员身份创建、修改、提交任何员工单据。
5. 每个状态变化写入不可变审计事件；业务审计与运行日志分离，禁止记录 OCR 原文、对象键、会话正文、向量和密钥。

## 迁移与切换策略

### 阶段 0：合同与基线

- 建立 monorepo 目录、OpenAPI、Go 服务骨架、React 空壳、Schema 权限与契约测试。
- 从当前 Vitest、Playwright 与 Prisma 集成测试提炼主链路行为测试，作为 Go/React 迁移回归基线。
- 此阶段不改变任何生产流量。

### 阶段 1：Go 纵向报销主链路

- 在 `reimbursement` Schema 实现员工、草稿、票据、费用项、校验、提交快照、审计、幂等和 Outbox。
- 接入 MinIO/ClamAV/PaddleOCR；先支持 Web 创建草稿、上传、OCR、校验、确认和提交。
- 用数据迁移工具复制现有有效草稿及已提交单据，保留原有字符串 ID 和提交编号；迁移后对数量、总额、票据哈希、状态和快照哈希进行校验。

### 阶段 2：React Web 切换

- React 以 OpenAPI Client 实现同一纵向主链路。
- 使用反向代理的路由开关，仅向内部测试员工开放 `/claims` 新入口。
- 通过关键旅程 E2E、API 契约和数据库对账后，将全体员工的“新建报销”切至 Go/React；旧 Next.js 仅保留历史单据只读入口。

### 阶段 3：Agent 迁移

- 抽离 `ReimbursementPort`，将飞书/Web Agent 的建单、上传、读取工作台、补字段、校验和提交依次替换为 Tool Gateway 调 Go。
- 通过 NATS 订阅 OCR 和单据状态事件；移除 Agent 对报销 Prisma Repository 的运行时依赖。
- 对一个内部测试飞书账号启用 Agent 新路径，完成附件、澄清、确认、提交和失败重试验收后灰度扩大。

### 阶段 4：后台、政策与复核

- 将人工复核、政策规则后台迁至 React/Go。
- 保持知识源/RAG 在 Agent/知识服务，只改为读取 Go 的生效规则摘要作解释上下文。
- 将旧 Next.js 后台转为只读，再完成退役。

### 阶段 5：关闭旧写入路径

- 对每个迁移完成的聚合，先关闭 Next.js 写接口，再部署 Go 唯一写入方；禁止双写、禁止复制写入补偿。
- 旧库保留只读访问和备份至满足财务留存要求；通过只读兼容 API 或历史页面提供查询。
- 删除 Prisma 领域写 Repository、旧 API Route 和对应 Docker 服务，保留迁移归档与可验证备份。

## 发布、回滚与可观测性

- 所有切换由按员工/渠道配置的功能开关控制，默认关闭；每批次必须可独立回退到旧入口。
- 回滚只切流量，不执行反向数据同步。已由 Go 创建的单据继续由 Go 管理；这避免两个系统对同一单据双写。
- 生产告警新增 Go API 错误率、Outbox 发布滞后、NATS 消费滞后、OCR 任务时延、工具调用失败率和 Agent/Go 授权失败率。
- 每个 HTTP、工具和事件处理流程携带 W3C `traceparent`、`request_id`、`tool_call_id` 和 `event_id`；高基数字段只写 JSON 日志，不作为 Loki 标签。
- 数据库备份、MinIO 对象版本、NATS 流保留策略和恢复演练须在 Go 写流量切换前完成。

## 验收标准

1. React 用户可在不启动 Agent 的情况下创建、上传、识别、补全、校验并提交报销单。
2. 飞书 Agent 使用相同 Go 业务 API 完成同一流程，且 Agent 数据库账号无 `reimbursement` Schema 权限。
3. 同一 `Idempotency-Key` 重试不会创建重复单据、附件或提交快照。
4. OCR 完成、复核要求和提交事件可从 NATS 到达 Agent，并且重复事件不会重复通知或修改业务事实。
5. Go 最终校验能阻止不合规提交，即使 Agent/RAG 给出相反的自然语言回答。
6. 每次 Agent 业务操作都可从业务审计关联到员工、渠道、会话、工具调用和请求追踪。
7. 切换期间不存在同一聚合的双写；数据对账证明迁移记录完整。

## 主要风险与控制

| 风险 | 控制措施 |
|---|---|
| 双写造成金额或状态不一致 | 聚合级唯一写入方、按渠道开关、只切流量不反向同步 |
| 飞书身份映射错误 | Go 作为映射权威；未绑定账号不发放委托令牌 |
| 附件绕过扫描或越权读取 | Go 发放短期上传会话；上传完成后再入库并扫描 |
| Agent 重试导致重复动作 | 工具调用与 Go API 均使用幂等键和持久化结果 |
| OCR/事件重复或乱序 | Outbox、JetStream、消费端事件去重、状态版本检查 |
| RAG 幻觉影响财务结果 | RAG 仅解释；Go 政策规则和最终校验唯一裁决 |
| 重构期间回归既有功能 | 从现有单元、集成和 E2E 测试提炼契约；按纵向主链路灰度 |

## 资源预估

在现有仓库作为行为参考、复用现有 OCR/知识库/飞书能力的前提下：两名工程师（Go 与 React/Agent）完成可生产试运行版本约 10 至 14 周；单人连续实施约 18 至 24 周。首个可演示的 Go + React 员工主链路目标为 4 至 6 周。
