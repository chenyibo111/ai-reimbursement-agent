# 飞书政策知识检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员从显式授权的飞书文档/Wiki 同步制度快照，使用 pgvector 与可替换 Embedding 服务检索证据，并让 Web 与飞书 Agent 给出带原文引用的政策问答。

**Architecture:** 文档来源、快照和切片保存在 PostgreSQL；向量列使用 pgvector，Embedding 服务在内部网络运行。同步器只处理管理员登记的来源，并在完整嵌入成功后原子切换当前快照；Agent 只接收有限检索片段，服务端验证引用，不把模型输出当作规则或事实来源。

**Tech Stack:** Next.js 15、TypeScript、Prisma 7、PostgreSQL 16 + pgvector、Docker Compose、BGE-M3 HTTP Embedding 服务、飞书开放平台 Node SDK、Zod、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-26-policy-knowledge-base-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-26-policy-rules-center-implementation.md` Tasks 1 and 4 (管理员授权与政策中心导航)。

## Execution Status (2026-09-26)

| Task | Status | Evidence |
|---|---|---|
| Task 1: pgvector、Embedding Provider 与容器运行边界 | Complete | 固定 1024 维配置、Fixture/HTTP Provider、内部 BGE-M3 服务、pgvector PostgreSQL 16 镜像与可选 GPU 覆盖已完成；聚焦测试 10/10、`npx tsc --noEmit` 与 `docker compose config --quiet` 通过。 |
| Task 2: 政策来源、快照、向量数据与飞书读取边界 | Complete | 受控 Docx/Wiki URL、飞书读取客户端、pgvector 来源/快照/切片迁移与参数化仓储已完成；聚焦测试 12/12、类型检查及专用测试库迁移通过。 |
| Task 3: 安全同步用例、管理员来源 API 与 Worker | Complete | 受控同步、失败保留活动快照、管理员来源 API 与 `policy:sync` Worker 已完成；聚焦测试 6/6、类型检查通过。 |
| Task 4: 检索、可验证引用与 Agent/飞书问答接入 | Not started | 等待安全同步与活动快照。 |
| Task 5: 管理界面、部署文档与完整验证 | Not started | 等待前序能力。 |

## Global Constraints

- 同步器只读取管理员已登记且启用的飞书新版文档或 Wiki 页面；禁止枚举、搜索或批量抓取飞书空间。
- 仅最新一次完整成功快照可检索；读取、切片或 Embedding 失败时保留旧快照。
- `embedding-service` 只能由 Docker 内部网络访问，不暴露公网端口；模型缓存必须持久化。
- `fixture` Embedding 只能用于测试/开发，生产环境不得以 fixture 建索引或回答。
- 文档正文、飞书 token、向量、对象键、票据原件和其他员工数据不得进入普通日志、模型系统提示或 API 错误响应。
- Agent 的政策回答必须附着服务端批准的检索引用；无证据、无来源或模型失败时使用安全降级文案。
- 飞书机器人继续只响应既有允许的消息；政策问答不得增加飞书侧规则发布、确认、删除或提交能力。

## Review Focus

- URL 伪造、非飞书域名、Wiki/docx token 缺失、管理员修改 `sourceId` 和未启用来源必须被拒绝；由 Task 2/3 API 测试锁定。
- 相同内容重复同步不得重新嵌入；下载、分块或第 N 批嵌入失败时旧快照仍能检索；由 Task 3 集成测试锁定。
- 模型维度变化、NaN/空向量、相似度阈值以下结果和 SQL 注入式查询文本必须安全失败；第一版索引固定为 BGE-M3 的 1024 维，由 Task 1/4 测试锁定。
- 文档中的提示注入、HTML、令牌样式文本或超长段落只能被当作数据，不能改变模型指令或泄露无关来源；由 Task 4 测试锁定。
- Embedding 服务不可用时，规则校验和非政策 Agent 功能保持可用，政策问答返回可恢复提示；由 Task 4/5 回归测试锁定。

---

## File structure

- `embedding-service/`：FastAPI/HTTP 服务、BGE-M3 加载、批量 Embedding、health endpoint 与 Dockerfile。
- `docker-compose.yml`、`Dockerfile`、`.env.example`：pgvector 镜像、模型缓存、GPU 可选配置与内部地址。
- `prisma/schema.prisma` 与迁移：`PolicySource`、`PolicyDocumentSnapshot`、`PolicyChunk` 及 pgvector 扩展/索引。
- `src/infrastructure/embedding/*`：Provider 接口、fixture、HTTP BGE-M3/OpenAI-compatible client 和向量仓储。
- `src/infrastructure/feishu/feishu-policy-document-client.ts`：文档/Wiki 链接解析及受控飞书读取。
- `src/application/sync-policy-source.ts`、`src/application/search-policy-knowledge.ts`：快照切换、切片、检索和引用 DTO。
- `src/worker/policy-sync.ts`：异步同步任务启动器；`app/api/admin/policy-sources/**`：来源管理与触发路由。
- `src/application/build-agent-context.ts`、`src/application/run-agent-turn.ts`、`src/application/process-feishu-event.ts`：检索上下文和引用约束。
- `app/(authenticated)/admin/policy-sources/page.tsx`、`src/ui/policy-source-manager.tsx`、`src/ui/policy-citations.tsx`：来源管理与回答引用展示。

### Task 1: pgvector、Embedding Provider 与容器运行边界

**Files:**
- Create: `embedding-service/Dockerfile`
- Create: `embedding-service/requirements.txt`
- Create: `embedding-service/app.py`
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Modify: `src/server/config.ts`
- Create: `src/infrastructure/embedding/embedding-provider.ts`
- Create: `src/infrastructure/embedding/fixture-embedding-provider.ts`
- Create: `src/infrastructure/embedding/http-embedding-provider.ts`
- Create: `src/infrastructure/embedding/embedding-provider-factory.ts`
- Test: `tests/unit/infrastructure/embedding-provider.test.ts`
- Test: `tests/unit/server/embedding-config.test.ts`

**Interfaces:**
- Produces: `EmbeddingProvider.embed(input: { texts: string[] }): Promise<number[][]>`; `createEmbeddingProvider(config: AppConfig): EmbeddingProvider`; `AppConfig.embedding` with provider, base URL, model and dimensions.
- Consumes: Docker Compose secret loading, existing production config validation, and Task 2's database migration contract.

- [x] **Step 1: Write failing configuration/provider tests**

Assert provider selection, production rejection of `fixture`, rejection of any first-version dimension other than `1024`, HTTP error/timeout mapping, empty text rejection, non-finite element rejection and a deterministic fixture vector for tests.

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/unit/infrastructure/embedding-provider.test.ts tests/unit/server/embedding-config.test.ts`

Expected: FAIL because the provider/configuration does not exist.

- [x] **Step 3: Implement provider contracts and Docker services**

Implement a bounded internal JSON batch API (`POST /embed`, `GET /health`) for BGE-M3. Add a named model-cache volume and an internal-only Compose service. Switch the PostgreSQL image to a pinned PostgreSQL-16 pgvector image after verifying its documented tag, preserve `postgres-data`, and add environment parsing for `fixture`, `bge-m3`, and `openai-compatible` providers. Fix the first-version index to 1024 dimensions; an OpenAI-compatible provider must return 1024 dimensions or be rejected. Keep GPU activation optional via a Compose override/profile so CPU deployment remains supported.

- [x] **Step 4: Run focused tests and Compose configuration validation**

Run: `npm run test -- tests/unit/infrastructure/embedding-provider.test.ts tests/unit/server/embedding-config.test.ts && docker compose config`

Expected: PASS; embedding has no host-published port and Postgres data volume name is unchanged.

- [x] **Step 5: Commit the Embedding runtime foundation**

```bash
git add embedding-service docker-compose.yml Dockerfile src/server src/infrastructure/embedding tests
git commit -m "feat: add local embedding service"
```

### Task 2: 政策来源、快照、向量数据与飞书读取边界

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_policy_knowledge/migration.sql`
- Create: `src/domain/policy-source.ts`
- Create: `src/infrastructure/prisma/policy-knowledge-repository.ts`
- Create: `src/infrastructure/feishu/feishu-policy-document-client.ts`
- Test: `tests/unit/domain/policy-source.test.ts`
- Test: `tests/unit/infrastructure/feishu-policy-document-client.test.ts`
- Test: `tests/integration/policy-knowledge-repository.test.ts`

**Interfaces:**
- Produces: `parsePolicySourceUrl(value: string): PolicySourceLocator`; `FeishuPolicyDocumentClient.read(locator): Promise<ReadPolicyDocument>`; `PolicyKnowledgeRepository` methods `createSource`, `getEnabledSourceForSync`, `stageSnapshot`, `activateSnapshot`, `searchChunks`.
- Consumes: policy administrator checks from the prerequisite plan and `EmbeddingProvider` dimensions from Task 1.

- [x] **Step 1: Write failing parser/client/repository tests**

Test accepted Feishu docx and Wiki URLs, rejected hosts/tokens/query surprises, source enable state, relation ordering, snapshot activation, previous-snapshot retention, fixed-dimension vector persistence, and parameterized search behavior.

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/unit/domain/policy-source.test.ts tests/unit/infrastructure/feishu-policy-document-client.test.ts tests/integration/policy-knowledge-repository.test.ts`

Expected: FAIL because policy knowledge persistence and client do not exist.

- [x] **Step 3: Implement source parsing, schema and read client**

Add source/snapshot/chunk tables, `CREATE EXTENSION IF NOT EXISTS vector`, a cosine HNSW index and an `Unsupported("vector(1024)")` Prisma field or equivalent migration-safe representation. Keep vector inserts/searches in repository methods using parameterized raw queries. Build a Feishu client that accepts only parsed locators and returns normalized title, revision, ordered heading/paragraph blocks, and canonical source URL; never logs tokens or full body. Treat a future non-1024 model as a separate schema migration and full reindex, never as a runtime configuration toggle.

- [x] **Step 4: Run focused tests and database migration checks**

Run: `$testDatabaseUrl = $env:TEST_DATABASE_URL; if (-not $testDatabaseUrl) { throw "TEST_DATABASE_URL is required" }; $env:DATABASE_URL = $testDatabaseUrl; npm run test -- tests/unit/domain/policy-source.test.ts tests/unit/infrastructure/feishu-policy-document-client.test.ts tests/integration/policy-knowledge-repository.test.ts; npx prisma migrate deploy`

Expected: PASS against the dedicated test database; vector extension and index are present without rebuilding existing PostgreSQL data.

- [x] **Step 5: Commit policy knowledge persistence**

```bash
git add prisma src/domain src/infrastructure tests
git commit -m "feat: store policy document snapshots"
```

### Task 3: 安全同步用例、管理员来源 API 与 Worker

**Files:**
- Create: `src/application/sync-policy-source.ts`
- Create: `src/application/split-policy-document.ts`
- Create: `src/worker/policy-sync.ts`
- Modify: `package.json`
- Create: `app/api/admin/policy-sources/route.ts`
- Create: `app/api/admin/policy-sources/[sourceId]/route.ts`
- Create: `app/api/admin/policy-sources/[sourceId]/sync/route.ts`
- Test: `tests/unit/application/split-policy-document.test.ts`
- Test: `tests/unit/application/sync-policy-source.test.ts`
- Test: `tests/integration/api/policy-source-routes.test.ts`
- Test: `tests/integration/policy-knowledge-repository.test.ts`

**Interfaces:**
- Consumes: `PolicyKnowledgeRepository`, `FeishuPolicyDocumentClient`, `EmbeddingProvider`, and `isPolicyAdmin`.
- Produces: `syncPolicySource(input: { actorId: string; sourceId: string }, deps): Promise<PolicySyncResult>` and `npm run policy:sync` worker entrypoint.

- [x] **Step 1: Write failing synchronization and API tests**

Cover non-admin access, bad request body, disabled source, unchanged content (zero embedding calls), changed content (new snapshot activation), read failure, split failure, second embedding batch failure, dimension mismatch and manual retry retaining the prior searchable snapshot.

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/unit/application/split-policy-document.test.ts tests/unit/application/sync-policy-source.test.ts tests/integration/api/policy-source-routes.test.ts tests/integration/policy-knowledge-repository.test.ts`

Expected: FAIL because no sync application service or routes exist.

- [x] **Step 3: Implement snapshot-safe synchronization**

Split only at normalized heading/paragraph boundaries using fixed maximum/minimum sizes and overlap decided in constants. Hash normalized content, return early on no change, stage a new snapshot, embed in bounded batches, and activate it only after all vectors are written. On any error, record a safe failure category and preserve the prior active snapshot. The worker must load `.env.local` like the existing Feishu worker, process only explicitly requested/enabled sources, and never accept source URLs from chat input.

- [x] **Step 4: Run focused tests and worker configuration test**

Run: `npm run test -- tests/unit/application/split-policy-document.test.ts tests/unit/application/sync-policy-source.test.ts tests/integration/api/policy-source-routes.test.ts tests/integration/policy-knowledge-repository.test.ts && npx tsc --noEmit`

Expected: PASS; a failed reindex cannot replace the previous searchable content.

- [x] **Step 5: Commit synchronization flow** (`5ba1ef9`)

```bash
git add app src package.json tests
git commit -m "feat: sync approved policy sources"
```

### Task 4: 检索、可验证引用与 Agent/飞书问答接入

**Files:**
- Create: `src/application/search-policy-knowledge.ts`
- Modify: `src/application/build-agent-context.ts`
- Modify: `src/application/run-agent-turn.ts`
- Modify: `src/infrastructure/model/chat-model.ts`
- Modify: `src/infrastructure/model/openai-compatible-chat-model.ts`
- Modify: `src/infrastructure/model/fake-chat-model.ts`
- Modify: `app/api/claims/[claimId]/chat/route.ts`
- Modify: `src/application/process-feishu-event.ts`
- Create: `src/ui/policy-citations.tsx`
- Modify: `src/ui/claim-chat.tsx`
- Test: `tests/unit/application/search-policy-knowledge.test.ts`
- Test: `tests/unit/application/run-agent-turn.test.ts`
- Test: `tests/integration/api/claim-chat.test.ts`
- Test: `tests/integration/feishu-bot-worker.test.ts`

**Interfaces:**
- Consumes: Task 1 `EmbeddingProvider`, Task 2 chunk search, Task 3 active snapshots.
- Produces: `searchPolicyKnowledge(input: { query: string; limit: number }): Promise<PolicyCitation[]>`; `AgentTurnResult.citations`; chat model output schema with `citationIds: string[]` restricted to supplied context.

- [x] **Step 1: Write failing retrieval and conversation tests**

Assert vector search is limited to active chunks, respects threshold/limit, returns title/URL/excerpt only, and excludes inactive/other-source chunks. Assert prompt-injection-like document text is sent as delimited data; model citation IDs outside results are dropped; no-results and embedding/model failures return the approved Chinese fallback; a bot policy question follows the same evidence path.

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/unit/application/search-policy-knowledge.test.ts tests/unit/application/run-agent-turn.test.ts tests/integration/api/claim-chat.test.ts tests/integration/feishu-bot-worker.test.ts`

Expected: FAIL because policy retrieval and citation validation are absent.

- [x] **Step 3: Implement retrieval and citation enforcement**

Embed the query, search active chunks with a fixed maximum and threshold, construct a data-only `policyEvidence` context, and never put document text into the model system instruction. Extend the model response schema with bounded citation IDs; service-side intersect them with retrieved IDs before returning. When no validated citation remains for a policy answer, return exactly the safe no-evidence response and no invented policy conclusion. Reuse this service from Web and Feishu processing.

- [x] **Step 4: Run focused tests, lint and type check**

Run: `npm run test -- tests/unit/application/search-policy-knowledge.test.ts tests/unit/application/run-agent-turn.test.ts tests/integration/api/claim-chat.test.ts tests/integration/feishu-bot-worker.test.ts && npm run lint && npx tsc --noEmit`

Expected: PASS; core Agent field proposals remain unchanged when the user is not asking a policy question.

- [x] **Step 5: Commit RAG conversation integration** (`d2d8ed2`)

```bash
git add app src tests
git commit -m "feat: answer policy questions with citations"
```

### Task 5: 管理界面、部署文档与完整验证

**Files:**
- Create: `app/(authenticated)/admin/policy-sources/page.tsx`
- Create: `src/ui/policy-source-manager.tsx`
- Modify: `app/(authenticated)/admin/policies/page.tsx`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `docs/feishu-integration.md`
- Test: `tests/e2e/policy-source-management.spec.ts`
- Test: existing `tests/**`

**Interfaces:**
- Consumes: Tasks 1–4 and the policy administrator page from the prerequisite plan.
- Produces: source add/enable/disable/sync UI and deployment/operator runbook.

- [x] **Step 1: Write source-management browser and API authorization tests**

Cover ordinary employee no-access, administrator source URL validation, add/disable/re-enable, sync busy/success/failure state, last successful sync retention, and visible source/citation link in an employee policy answer.

- [x] **Step 2: Run and correct the focused browser test**

Run: `npm run test:e2e -- tests/e2e/policy-source-management.spec.ts`

Expected: FAIL because the source-management page does not exist.

- [x] **Step 3: Implement source management and operations documentation**

Build an accessible responsive source list/form that never renders full document bodies. Show source type, canonical link, enabled state, last successful sync, safe failure text and manual sync action. Document first model download, model cache backup, optional GPU Compose override, production internal networking, pgvector migration backup, required Feishu document/Wiki scopes, and rollback behavior.

- [x] **Step 4: Run all verification suites and Compose smoke checks**

Run: `npm run test && npm run lint && npx tsc --noEmit && npm run test:e2e && docker compose config`

Expected: PASS; existing claims, OCR, deletion, OAuth and Feishu bot flows remain functional, and no service exposes embedding publicly.

- [ ] **Step 5: Commit the knowledge retrieval milestone**

```bash
git add app src docs README.md tests docker-compose.yml
git commit -m "feat: add policy knowledge retrieval"
```
