# React + Go 报销平台重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 Next.js/Prisma 报销原型渐进迁移为 React Web、Go 报销核心与独立 TypeScript Agent，且任一切换阶段没有同一聚合的双写。

**Architecture:** Go 服务以 OpenAPI 3.1、PostgreSQL `reimbursement` Schema、Outbox 和 NATS JetStream 作为唯一报销业务边界。React 只调用生成的 Go API Client；Agent 通过 `ReimbursementPort` 和 Tool Gateway 调同一 API，并将会话、RAG 与渠道状态保留在 `agent` Schema。旧 Next.js 系统在按渠道/员工灰度迁移期间仅承载未迁移数据，迁移成功后转为历史只读入口。

**Tech Stack:** Go 1.27.1、chi、pgx/v5、sqlc、goose、oapi-codegen、React 19、Vite、TypeScript、React Router、TanStack Query、PostgreSQL 16、MinIO、ClamAV、PaddleOCR、NATS JetStream、Node.js 24、Vitest、Playwright、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-10-07-react-go-replatforming-design.md`

## Global Constraints

- Go 报销服务是 `reimbursement.*` 的唯一写入方；Agent 账号对该 Schema 没有写权限。
- Agent 是 `agent.*` 的唯一写入方；跨服务仅通过 API 和事件传递字符串 ID，不创建跨 Schema 外键或事务。
- React 与 Agent 不得直接连接报销领域数据库。
- 所有报销变更 API 必须要求并持久化 `Idempotency-Key`；重复键返回第一次结果，不重复执行副作用。
- 上传附件须经 Go 创建上传会话、完成校验、病毒扫描和 OCR 任务编排；不得直接将对象键写入数据库。
- 模型、RAG 与 Tool Gateway 不能绕过 Go 的资源级权限、版本检查、政策校验和提交确认。
- Outbox 事件在业务写事务中创建；消费者按 `event_id` 幂等处理。
- 不得将对象键、OCR 原文、会话正文、向量、Token、Webhook 或飞书身份标识写入日志或事件载荷。
- 任意切换仅切流量，不做双写或反向同步；已由 Go 创建的单据永远由 Go 管理。

## Review Focus

- 同一个 `Idempotency-Key` 在网络重试和并发请求下只创建一张草稿、一份附件或一个提交快照。
- 已提交单据、非所有者、过期确认令牌和过期委托令牌均不能改变单据状态。
- Agent 重复接收飞书事件、NATS 事件或 OCR 回调时不会重复上传、重复通知或重复提交。
- 上传完成但扫描、对象存储或 OCR 任一环节失败时，不会留下可提交的孤立票据或伪成功状态。
- 灰度切换期间，旧单据和新单据可正确路由到各自唯一写入方，任何入口都不会静默跨边界修改它们。

---

## File Structure

```text
api/openapi/reimbursement-v1.yaml                 # 唯一外部/内部 HTTP 契约
apps/web/                                         # Vite React 单页应用
services/reimbursement-api/
  cmd/api/main.go                                 # Go HTTP 入口
  cmd/worker/main.go                              # Outbox/OCR Worker 入口
  internal/domain/                                # Claim、Receipt、Policy 纯领域规则
  internal/application/                           # 命令、查询、授权与提交编排
  internal/transport/http/                        # oapi-codegen handler 与 middleware
  internal/store/                                 # sqlc 查询、事务与 repository adapter
  internal/infrastructure/                        # MinIO、ClamAV、OCR、NATS adapter
  db/migrations/                                  # Goose migration
  db/queries/                                     # sqlc SQL
  tests/                                          # unit、integration、contract tests
services/agent/
  src/ports/reimbursement-port.ts                 # Agent 唯一报销依赖
  src/adapters/reimbursement-api-client.ts        # Go OpenAPI client adapter
  src/tool-gateway/                               # typed tool contract/MCP 适配入口
  src/events/reimbursement-consumer.ts            # NATS 消费与去重
  src/repositories/                               # agent.* 专属持久化
infra/nats/                                       # JetStream stream/consumer 配置
infra/nginx/                                      # React + API 的受控路由与切流配置
scripts/migration/                                # 对账、一次性迁移、只读验收脚本
tests/contract/                                   # OpenAPI、Agent Port、事件 schema 契约
```

### Task 1: 建立迁移工作区、契约基线与防直连约束

**Files:**
- Create: `api/openapi/reimbursement-v1.yaml`
- Create: `services/reimbursement-api/go.mod`
- Create: `apps/web/package.json`
- Create: `services/agent/package.json`
- Create: `tests/contract/openapi-contract.test.ts`
- Create: `tests/contract/no-direct-domain-db-access.test.ts`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: OpenAPI 3.1 的 `Claim`、`Receipt`、`ValidationIssue`、`SubmissionRequest`、`ErrorResponse` 组件及草稿/上传/校验/提交路径。
- Produces: 仅允许 Go 服务使用 `REIMBURSEMENT_DATABASE_URL` 的 Compose 服务拓扑。

- [ ] **Step 1: 为第一个纵向链路写契约失败测试**

```ts
it("defines idempotent draft, upload-finalize, validation, submission request, and submit endpoints", () => {
  expect(document.paths).toHaveProperty("/api/v1/claims");
  expect(document.paths).toHaveProperty("/api/v1/claims/{claimId}/uploads");
  expect(document.components.schemas.ErrorResponse.properties).toHaveProperty("code");
});
```

- [ ] **Step 2: 运行契约测试确认失败**

Run: `npm test -- tests/contract/openapi-contract.test.ts`

Expected: FAIL，因为 API 契约和工作区尚不存在。

- [ ] **Step 3: 创建 OpenAPI、Go/React/Agent 工作区骨架与 Compose 内网服务定义**

在 OpenAPI 中定义 `/api/v1/claims`、`/uploads`、`/receipts`、`/validation`、`/submission-requests`、`/submit`；所有可变操作声明 `Idempotency-Key`。Compose 仅暴露受控的 Go API 和 React 前端，禁止为 PostgreSQL、NATS、OCR、Agent Tool Gateway 添加公网端口。

- [ ] **Step 4: 增加防止 React/Agent 连接 `reimbursement.*` 的静态契约测试**

断言 `apps/web` 和 `services/agent` 没有 `pgx`、`DATABASE_URL` 或 Go 报销 Schema 连接配置；断言 Agent 的唯一报销依赖是 `ReimbursementPort`。

- [ ] **Step 5: 运行通过测试与配置校验**

Run: `npm test -- tests/contract/openapi-contract.test.ts tests/contract/no-direct-domain-db-access.test.ts && docker compose config --quiet`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add api/openapi services/reimbursement-api/go.mod apps/web/package.json services/agent/package.json tests/contract docker-compose.yml README.md
git commit -m "chore: scaffold React Go reimbursement workspace"
```

### Task 2: 建立数据库所有权、身份与幂等存储

**Files:**
- Create: `services/reimbursement-api/db/migrations/000001_reimbursement_schema.sql`
- Create: `services/reimbursement-api/db/migrations/000002_idempotency_outbox.sql`
- Create: `services/reimbursement-api/db/queries/employees.sql`
- Create: `services/reimbursement-api/db/queries/idempotency.sql`
- Create: `services/reimbursement-api/internal/store/idempotency.go`
- Create: `services/reimbursement-api/internal/store/idempotency_test.go`
- Create: `services/reimbursement-api/tests/schema_permissions_test.go`

**Interfaces:**
- Produces: `reimbursement` 与 `agent` Schema、最小权限数据库角色、`employees`、`idempotency_records`、`outbox_events` 表。
- Produces: `ExecuteIdempotent(ctx, actorID, key, requestHash, fn) (StoredResponse, error)`。

- [ ] **Step 1: 写失败的集成测试，覆盖相同键重放与请求内容冲突**

```go
func TestExecuteIdempotent_ReplaysStoredResponse(t *testing.T) { /* second execution must not call fn */ }
func TestExecuteIdempotent_RejectsSameKeyWithDifferentRequest(t *testing.T) { /* expect IDEMPOTENCY_CONFLICT */ }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/store -run TestExecuteIdempotent -count=1`

Expected: FAIL，因为 migration 与 store 尚不存在。

- [ ] **Step 3: 编写 Goose migration 和 sqlc 查询**

创建 `reimbursement` Schema、最小 `employees` 表、角色授权、幂等记录、Outbox 表及唯一索引。幂等记录以员工、操作名和键唯一，并持久化请求哈希、HTTP 状态和响应 JSON。

- [ ] **Step 4: 实现事务内的幂等执行器**

使用 `pgx` 事务和唯一冲突读取第一次结果；请求哈希不一致返回领域错误，不能覆盖旧结果。

- [ ] **Step 5: 运行数据库集成测试**

Run: `cd services/reimbursement-api && go test ./internal/store ./tests -count=1`

Expected: PASS，包含权限断言：Agent 数据库角色不能查询或写入 `reimbursement` Schema。

- [ ] **Step 6: Commit**

```bash
git add services/reimbursement-api/db services/reimbursement-api/internal/store services/reimbursement-api/tests
git commit -m "feat: add reimbursement schema and idempotency store"
```

### Task 3: 实现 Go 报销聚合与草稿/字段主链路

**Files:**
- Create: `services/reimbursement-api/internal/domain/claim.go`
- Create: `services/reimbursement-api/internal/domain/claim_test.go`
- Create: `services/reimbursement-api/internal/application/create_claim.go`
- Create: `services/reimbursement-api/internal/application/update_claim.go`
- Create: `services/reimbursement-api/internal/application/get_claim.go`
- Create: `services/reimbursement-api/internal/store/claim_repository.go`
- Create: `services/reimbursement-api/db/queries/claims.sql`
- Create: `services/reimbursement-api/internal/application/claim_service_test.go`

**Interfaces:**
- Consumes: Task 2 `ExecuteIdempotent`。
- Produces: `CreateClaim(ctx, actor, CreateClaimCommand) (ClaimView, error)`、`UpdateClaim(ctx, actor, claimID, expectedVersion, PatchClaimCommand) (ClaimView, error)`、`GetClaim(ctx, actor, claimID) (ClaimView, error)`。

- [ ] **Step 1: 写领域和应用服务失败测试**

```go
func TestCreateClaim_AssignsDraftToActor(t *testing.T) {}
func TestUpdateClaim_RejectsAnotherEmployeesClaim(t *testing.T) {}
func TestUpdateClaim_RejectsStaleVersion(t *testing.T) {}
func TestUpdateClaim_RejectsSubmittedClaim(t *testing.T) {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/domain ./internal/application -run 'Test(CreateClaim|UpdateClaim)' -count=1`

Expected: FAIL，因为 Claim 聚合与应用服务尚不存在。

- [ ] **Step 3: 建立 Claim、ExpenseItem 和业务审计存储模型**

保留当前字符串 ID 兼容现有链接，维护版本号乐观锁；草稿、字段更新、删除只允许资源所有者和 `DRAFT` 状态。每个成功变更写业务审计和 Outbox。

- [ ] **Step 4: 实现草稿创建、读取、字段更新与草稿删除**

`purpose`、费用分类、参与人、项目编号等字段以显式 Patch Command 白名单处理；未知字段返回 `VALIDATION_BLOCKED`，不得透传任意 JSON。

- [ ] **Step 5: 运行测试**

Run: `cd services/reimbursement-api && go test ./internal/domain ./internal/application ./internal/store -count=1`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add services/reimbursement-api/internal services/reimbursement-api/db/queries
git commit -m "feat: add Go claim draft application service"
```

### Task 4: 实现受控附件上传、扫描、OCR 与重复票据校验

**Files:**
- Create: `services/reimbursement-api/internal/application/upload_receipt.go`
- Create: `services/reimbursement-api/internal/application/extract_receipt.go`
- Create: `services/reimbursement-api/internal/domain/receipt.go`
- Create: `services/reimbursement-api/internal/infrastructure/minio_store.go`
- Create: `services/reimbursement-api/internal/infrastructure/clamav_scanner.go`
- Create: `services/reimbursement-api/internal/infrastructure/ocr_client.go`
- Create: `services/reimbursement-api/internal/store/receipt_repository.go`
- Create: `services/reimbursement-api/db/queries/receipts.sql`
- Create: `services/reimbursement-api/internal/application/upload_receipt_test.go`
- Create: `services/reimbursement-api/internal/application/extract_receipt_test.go`

**Interfaces:**
- Consumes: Task 3 Claim ownership/version; Task 2 Outbox。
- Produces: `CreateUploadSession`、`FinalizeReceiptUpload`、`ExtractReceipt` 和 `ReceiptExtractionCompleted` 事件。

- [ ] **Step 1: 写失败测试，覆盖 MIME/签名/大小、病毒、重复文件与已提交发票号**

```go
func TestFinalizeReceiptUpload_RejectsInvalidSignature(t *testing.T) {}
func TestFinalizeReceiptUpload_RejectsUnsafeFile(t *testing.T) {}
func TestExtractReceipt_FlagsDuplicateSubmittedInvoice(t *testing.T) {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/application -run 'Test(FinalizeReceiptUpload|ExtractReceipt)' -count=1`

Expected: FAIL，因为附件应用服务尚不存在。

- [ ] **Step 3: 实现两步上传与文件前置校验**

支持 JPG、PNG、PDF，最大 20MB；验证文件签名与 PDF 页数，使用短期最小权限预签名 URL。完成上传后，Go 校验对象、调用 ClamAV、写 Receipt/Audit/Outbox，不向 API 响应泄露对象键。

- [ ] **Step 4: 实现 OCR 回调处理和重复校验**

Go Worker 从受控对象读取附件并调用既有 OCR HTTP 服务；成功后创建或更新费用项，保存受控提取字段、置信度和校验问题。内容哈希重复和已提交发票号码均创建阻断问题和复核事件。

- [ ] **Step 5: 运行单元和容器集成测试**

Run: `cd services/reimbursement-api && go test ./... -count=1`

Expected: PASS；测试替换 MinIO、ClamAV、OCR 为确定性 fake，不调用真实模型。

- [ ] **Step 6: Commit**

```bash
git add services/reimbursement-api/internal services/reimbursement-api/db/queries
git commit -m "feat: add secured receipt ingestion and OCR"
```

### Task 5: 实现 Go 校验、确认与提交快照

**Files:**
- Create: `services/reimbursement-api/internal/domain/validation.go`
- Create: `services/reimbursement-api/internal/application/validate_claim.go`
- Create: `services/reimbursement-api/internal/application/request_submission.go`
- Create: `services/reimbursement-api/internal/application/submit_claim.go`
- Create: `services/reimbursement-api/internal/application/submission_test.go`
- Create: `services/reimbursement-api/internal/store/submission_repository.go`
- Create: `services/reimbursement-api/db/queries/submissions.sql`

**Interfaces:**
- Consumes: Task 3 Claim，Task 4 Receipt/ExpenseItem。
- Produces: `ValidateClaim`、`RequestSubmission`、`SubmitClaim` 及不可变 `SubmissionSnapshot`。

- [ ] **Step 1: 写失败测试，覆盖阻断项、确认令牌、重放与版本变化**

```go
func TestSubmitClaim_RevalidatesBeforeSubmit(t *testing.T) {}
func TestSubmitClaim_RejectsStaleConfirmation(t *testing.T) {}
func TestSubmitClaim_ReplaysIdempotentSubmission(t *testing.T) {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/application -run TestSubmitClaim -count=1`

Expected: FAIL，因为提交应用服务尚不存在。

- [ ] **Step 3: 迁移当前基础校验与政策规则合同到 Go**

先实现报销事由、费用存在、重复票据、低置信度确认、已提交不可修改等基础规则；为 `PolicyVersion` 与 `PolicyRule` 建立接口，使后续规则中心可替换，而不让 RAG 参与裁决。

- [ ] **Step 4: 实现确认请求和最终提交事务**

确认令牌绑定 claim、版本、员工和过期时间；提交事务重读版本、重新校验、写唯一提交编号、提交快照、审计及 `claim.submitted.v1` Outbox 事件。

- [ ] **Step 5: 运行应用服务和数据库集成测试**

Run: `cd services/reimbursement-api && go test ./internal/application ./internal/store -count=1`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add services/reimbursement-api/internal services/reimbursement-api/db/queries
git commit -m "feat: add Go validation and claim submission"
```

### Task 6: 发布 HTTP API、认证与 OpenAPI 兼容性测试

**Files:**
- Create: `services/reimbursement-api/cmd/api/main.go`
- Create: `services/reimbursement-api/internal/transport/http/router.go`
- Create: `services/reimbursement-api/internal/transport/http/claims_handler.go`
- Create: `services/reimbursement-api/internal/transport/http/auth_middleware.go`
- Create: `services/reimbursement-api/internal/transport/http/error_mapper.go`
- Create: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Create: `services/reimbursement-api/tests/openapi_compatibility_test.go`
- Modify: `api/openapi/reimbursement-v1.yaml`

**Interfaces:**
- Consumes: Tasks 2–5 application services。
- Produces: 满足 OpenAPI 的 `/api/v1` HTTP 服务和经认证的 `Actor` 上下文。

- [ ] **Step 1: 写 HTTP 失败测试**

```go
func TestCreateClaim_RequiresAuthenticationAndIdempotencyKey(t *testing.T) {}
func TestSubmitClaim_ReturnsValidationBlockedWithoutLeakingInternals(t *testing.T) {}
func TestClaimEndpointsMatchOpenAPIContract(t *testing.T) {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/transport/http ./tests -run 'Test(CreateClaim|SubmitClaim|ClaimEndpoints)' -count=1`

Expected: FAIL，因为 router 与 handler 尚不存在。

- [ ] **Step 3: 生成模型并实现认证、授权、错误映射与 handler**

使用 `oapi-codegen` 生成请求/响应模型；HttpOnly 会话或企业 OIDC Bearer Token 转为 Actor。Handler 只解析协议、调用应用服务、映射稳定错误码，不放置领域规则。

- [ ] **Step 4: 实现内部受委托 API 中间件**

验证 Agent 服务凭据及短期委托 JWT 的签名、`aud`、到期时间、`jti`、员工状态和渠道。将 `tool_call_id` 写入审计与日志关联字段。

- [ ] **Step 5: 运行完整 HTTP 契约测试**

Run: `cd services/reimbursement-api && go test ./internal/transport/http ./tests -count=1 && npm test -- tests/contract/openapi-contract.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add api/openapi services/reimbursement-api/cmd services/reimbursement-api/internal/transport services/reimbursement-api/tests
git commit -m "feat: expose authenticated reimbursement API"
```

### Task 7: 引入 Outbox Publisher、NATS 与 OCR/状态事件消费者

**Files:**
- Create: `infra/nats/jetstream.conf`
- Create: `services/reimbursement-api/internal/events/outbox_publisher.go`
- Create: `services/reimbursement-api/internal/events/outbox_publisher_test.go`
- Create: `services/reimbursement-api/cmd/worker/main.go`
- Create: `services/reimbursement-api/internal/workers/receipt_extraction.go`
- Create: `services/reimbursement-api/internal/workers/receipt_extraction_test.go`
- Modify: `docker-compose.yml`
- Modify: `observability/config.alloy`

**Interfaces:**
- Consumes: Tasks 2, 4, 5 Outbox records。
- Produces: JetStream subjects `reimbursement.claim.*`、`reimbursement.receipt.*` 和事件 envelope `{event_id,event_type,occurred_at,aggregate_id,payload}`。

- [ ] **Step 1: 写失败测试，覆盖 Outbox 原子性、发布重试与消费者去重**

```go
func TestOutboxPublisher_DoesNotPublishUncommittedEvent(t *testing.T) {}
func TestOutboxPublisher_RetriesAndMarksPublishedOnce(t *testing.T) {}
func TestReceiptWorker_DeduplicatesEventID(t *testing.T) {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/events ./internal/workers -count=1`

Expected: FAIL，因为 Publisher、NATS 和 Worker 尚不存在。

- [ ] **Step 3: 在 Compose 增加私有 NATS JetStream 与健康检查**

创建持久卷、明确 Stream/Consumer 保留时间和资源限制；不添加主机端口。将 Go API、Go Worker 与 Agent 加入同一私有网络。

- [ ] **Step 4: 实现 Publisher 和 OCR Worker**

Publisher 使用 `FOR UPDATE SKIP LOCKED` 领取 Outbox；Worker 以 `event_id` 去重、执行 OCR、写入结果与复核事件。失败按照有限次数重试，最终进入 Go 复核队列而不是无限循环。

- [ ] **Step 5: 运行 Docker 集成测试与日志契约测试**

Run: `docker compose --profile migration up -d --build nats reimbursement-api reimbursement-worker && cd services/reimbursement-api && go test ./... -count=1`

Expected: PASS；日志不含凭据、对象键或 OCR 原文。

- [ ] **Step 6: Commit**

```bash
git add infra/nats services/reimbursement-api/internal/events services/reimbursement-api/internal/workers services/reimbursement-api/cmd/worker docker-compose.yml observability/config.alloy
git commit -m "feat: add reimbursement outbox and event workers"
```

### Task 8: 实现 React 主链路与生成 API Client

**Files:**
- Create: `apps/web/src/api/generated/`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/routes/claims-list-page.tsx`
- Create: `apps/web/src/routes/claim-workbench-page.tsx`
- Create: `apps/web/src/features/claims/use-claim.ts`
- Create: `apps/web/src/features/receipts/use-receipt-upload.ts`
- Create: `apps/web/src/features/submission/use-submission.ts`
- Create: `apps/web/src/test/server.ts`
- Create: `apps/web/src/features/claims/claim-workbench.test.tsx`
- Create: `apps/web/e2e/claim-submission.spec.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: Task 6 OpenAPI contract。
- Produces: 不依赖 Agent 的 React 报销列表、草稿工作台、上传、校验与提交用户旅程。

- [ ] **Step 1: 写失败的组件和 E2E 测试**

```tsx
it("shows OCR-pending receipt and blocks submit until validation passes", async () => {});
test("employee creates, uploads, confirms, and submits a claim", async ({ page }) => {});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && npm test -- claim-workbench.test.tsx && npm run test:e2e -- claim-submission.spec.ts`

Expected: FAIL，因为 React 工作台尚不存在。

- [ ] **Step 3: 从 OpenAPI 生成 TypeScript Client 并实现 React Query hooks**

Client 只接受 Go Base URL；为读取、草稿更新、上传完成、校验和提交使用明确 mutation/query hooks。每个 mutation 生成并复用请求级幂等键。

- [ ] **Step 4: 实现列表和工作台交互状态**

展示 OCR 处理中、识别完成、需复核、阻断校验、确认摘要和提交成功；错误根据稳定 `code` 呈现可操作说明，不展示数据库或内部堆栈。

- [ ] **Step 5: 运行前端测试与真实 API E2E**

Run: `cd apps/web && npm test && npm run test:e2e`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web api/openapi
git commit -m "feat: add React reimbursement workbench"
```

### Task 9: 迁移 Agent 到 ReimbursementPort 与 Tool Gateway

**Files:**
- Create: `services/agent/src/ports/reimbursement-port.ts`
- Create: `services/agent/src/ports/reimbursement-port.test.ts`
- Create: `services/agent/src/adapters/reimbursement-api-client.ts`
- Create: `services/agent/src/tool-gateway/reimbursement-tools.ts`
- Create: `services/agent/src/tool-gateway/reimbursement-tools.test.ts`
- Create: `services/agent/src/events/reimbursement-consumer.ts`
- Create: `services/agent/src/events/reimbursement-consumer.test.ts`
- Modify: `services/agent/src/application/run-conversation-turn.ts`
- Modify: `services/agent/src/worker/feishu-bot-runtime.ts`

**Interfaces:**
- Consumes: Task 6 delegated API and Task 7 events。
- Produces: `ReimbursementPort`，其方法与 `create_claim_draft` 至 `submit_claim` 八个工具一一对应。

- [ ] **Step 1: 写 Port 与工具失败测试**

```ts
it("passes actor, channel, conversation, tool call, and idempotency metadata to Go", async () => {});
it("does not retry a completed tool call after a duplicate Feishu message", async () => {});
it("uses receipt.extraction.completed only to notify and refetches the workbench", async () => {});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/agent && npm test -- reimbursement-port.test.ts reimbursement-tools.test.ts reimbursement-consumer.test.ts`

Expected: FAIL，因为 Port 和 Go API Adapter 尚不存在。

- [ ] **Step 3: 定义最小 Port 和 Go OpenAPI Adapter**

移植现有对话业务规则，但删除对 `ClaimRepository`、`ReceiptRepository`、`AsyncJobRepository` 的运行时依赖。Adapter 只调用 Go API，并为每次 Agent tool call 生成稳定 `Idempotency-Key`。

- [ ] **Step 4: 实现 Tool Gateway 与事件消费者**

工具层验证模型参数、附加受委托身份、调用 Port 并持久化 tool result。NATS 消费者按 `event_id` 去重，只用事件驱动通知；工作台数据始终从 Go API 重新读取。

- [ ] **Step 5: 迁移飞书/Web 对话编排并运行跨渠道测试**

Run: `cd services/agent && npm test && npm run test:e2e -- agent-confirmation`

Expected: PASS；飞书附件、补充事由、确认提交和 OCR 完成通知均不直连报销数据库。

- [ ] **Step 6: Commit**

```bash
git add services/agent tests/contract
git commit -m "feat: decouple agent through reimbursement tools"
```

### Task 10: 迁移数据、路由灰度与对账工具

**Files:**
- Create: `scripts/migration/export-legacy-claims.ts`
- Create: `scripts/migration/import-reimbursement-data.go`
- Create: `scripts/migration/reconcile-claims.go`
- Create: `scripts/migration/reconcile-claims_test.go`
- Create: `infra/nginx/reimbursement-routes.conf`
- Create: `services/reimbursement-api/internal/application/legacy_import.go`
- Create: `services/reimbursement-api/internal/application/legacy_import_test.go`
- Modify: `docker-compose.yml`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: Task 5 domain model and Task 8/9 channel routing。
- Produces: 可重复执行的迁移清单、只读对账报告和按员工/渠道的流量开关。

- [ ] **Step 1: 写迁移失败测试，覆盖 ID 保留、金额/哈希对账与重复导入**

```go
func TestLegacyImport_PreservesClaimAndSubmissionIdentifiers(t *testing.T) {}
func TestLegacyImport_IsIdempotent(t *testing.T) {}
func TestReconcile_ReportsMissingReceiptHashAndStatusMismatch(t *testing.T) {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/application ../../scripts/migration -run 'Test(LegacyImport|Reconcile)' -count=1`

Expected: FAIL，因为迁移工具尚不存在。

- [ ] **Step 3: 实现只读导出、幂等导入与对账**

导出旧库有效草稿和已提交单据；导入保留现有 claim ID、receipt ID、提交编号、金额、状态和内容哈希。对账报告必须比较记录数量、状态、总额、附件哈希和提交快照摘要。

- [ ] **Step 4: 实现路由开关与唯一写入方策略**

功能开关以员工和渠道为维度。切换到 Go 后，Next.js 对该范围的写请求返回迁移指引；Go 不读取或修改遗留表。撤回开关只影响尚未创建的新流量，不回写既有 Go 单据。

- [ ] **Step 5: 运行预生产迁移演练**

Run: `docker compose --profile migration run --rm reconciliation && cd services/reimbursement-api && go test ./... -count=1`

Expected: PASS，且对账报告无差异后才允许灰度。

- [ ] **Step 6: Commit**

```bash
git add scripts/migration infra/nginx services/reimbursement-api/internal/application docker-compose.yml docs/operations.md
git commit -m "feat: add reimbursement migration and reconciliation"
```

### Task 11: 迁移后台能力、政策裁决与人工复核

**Files:**
- Create: `services/reimbursement-api/internal/application/policy_rules.go`
- Create: `services/reimbursement-api/internal/application/review_cases.go`
- Create: `services/reimbursement-api/internal/transport/http/admin_handler.go`
- Create: `apps/web/src/routes/review-center-page.tsx`
- Create: `apps/web/src/routes/policy-rules-page.tsx`
- Create: `apps/web/src/features/reviews/review-center.test.tsx`
- Create: `apps/web/src/features/policies/policy-rules.test.tsx`
- Modify: `api/openapi/reimbursement-v1.yaml`
- Modify: `services/agent/src/application/policy-context.ts`

**Interfaces:**
- Consumes: Tasks 5–8。
- Produces: Go 所有的规则发布、复核领取/更正/重试 API，和 React 财务后台页面。

- [ ] **Step 1: 写失败测试，覆盖角色、政策生效日和复核操作审计**

```go
func TestPublishPolicy_ArchivesPriorVersionAtomically(t *testing.T) {}
func TestResolveReviewCase_RequiresFinanceReviewer(t *testing.T) {}
```

```tsx
it("shows only assigned or claimable cases and records correction outcome", async () => {});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/reimbursement-api && go test ./internal/application -run 'Test(PublishPolicy|ResolveReviewCase)' -count=1`

Expected: FAIL，因为后台领域服务尚未迁移。

- [ ] **Step 3: 实现 Go 政策与复核应用服务**

政策规则的发布、归档和提交时快照均在 Go 事务中完成；OCR 与同步失败进入统一 ReviewCase。RAG 仅读取 Go 的公开生效规则摘要，不获得写权限。

- [ ] **Step 4: 实现 OpenAPI 管理接口和 React 后台**

以 Go 角色为唯一鉴权依据，前端不传角色。复核更正必须产生审计记录、重新校验和必要的 OCR/同步重试事件。

- [ ] **Step 5: 运行跨服务验收测试**

Run: `cd services/reimbursement-api && go test ./... -count=1 && cd ../../apps/web && npm test && npm run test:e2e -- review-center`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add services/reimbursement-api apps/web services/agent api/openapi
git commit -m "feat: migrate policy and review administration"
```

### Task 12: 生产演练、切流与退役旧写路径

**Files:**
- Create: `docs/migration/react-go-cutover-runbook.md`
- Create: `docs/migration/legacy-retirement-checklist.md`
- Create: `tests/e2e/react-go-cutover.spec.ts`
- Modify: `docs/operations.md`
- Modify: `README.md`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: Tasks 1–11。
- Produces: 可执行切流 Runbook、回滚决策表、遗留系统只读策略与最终验收报告模板。

- [ ] **Step 1: 写切流失败测试**

```ts
test("new employee traffic uses Go APIs while legacy claims remain read-only in the old application", async () => {});
test("Agent and Web produce equivalent Go audit records for the same permitted operation", async () => {});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:e2e -- react-go-cutover`

Expected: FAIL，因为灰度路由和遗留只读策略尚未完成。

- [ ] **Step 3: 编写并执行预生产演练 Runbook**

Runbook 必须定义：备份验证、Schema migration、NATS stream 创建、数据导入/对账、首批内部员工开关、监控阈值、回滚条件、数据归属和故障沟通。禁止用清库、回写或停 OCR 服务作为回滚方式。

- [ ] **Step 4: 将遗留 Next.js 领域写接口切为只读并移除 Agent 直连依赖**

删除已经完全迁移聚合的 Prisma 写 Repository 和对应 API Route；保留历史查询、备份和兼容重定向，直到财务留存要求满足。

- [ ] **Step 5: 执行全量验证**

Run: `cd services/reimbursement-api && go test ./... -count=1 && cd ../../apps/web && npm test && npm run test:e2e && cd ../../services/agent && npm test && docker compose --profile observability config --quiet`

Expected: PASS；迁移对账无差异、告警与审计链路正常。

- [ ] **Step 6: Commit**

```bash
git add docs/migration tests/e2e docs/operations.md README.md docker-compose.yml
git commit -m "docs: add React Go production cutover runbook"
```

## Plan Self-Review

- **Spec coverage:** 12 个任务覆盖服务边界、存储所有权、外部 API、身份、上传/OCR、校验提交、Outbox/NATS、React、Agent、迁移、后台和切流。
- **Step precision:** 每项任务均指定文件、所消费/产出的接口、失败测试、实现、验证及提交步骤。
- **Type consistency:** Agent 始终依赖 `ReimbursementPort`；Go API 和事件均以字符串 ID、`event_id`、`Idempotency-Key` 与稳定错误码作为跨边界合同。
- **Review focus coverage:** 幂等由 Tasks 2、5、6、9 验证；权限与提交状态由 Tasks 3、5、6 验证；事件重复由 Task 7、9 验证；附件失败由 Task 4 验证；切换唯一写入方由 Task 10、12 验证。
- **Proportion:** 第一阶段的可演示纵向闭环为 Tasks 1–8；Tasks 9–12 将 Agent、后台和生产切流逐步接入，不要求一次性完成。
