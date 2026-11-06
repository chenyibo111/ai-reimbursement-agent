# Next.js 完整退役 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 React + Go 成为唯一 Web 入口，让四个 Node 服务使用不含 Next.js 的运行镜像，同时保留 Agent、政策知识库、历史数据与现有身份边界。

**Architecture:** 浏览器继续经 Nginx 访问 Go Auth BFF 与 `/api/v1/*`；新增的政策来源请求由 Go 验证实时 SSO 会话和 `ADMIN` 角色后转发给仅在 Compose 内网开放的 Agent 管理服务。Agent 管理服务复用 Prisma 政策来源仓储、异步任务仓储和同步 Worker，不在 Go 中复制向量化逻辑。四个 Node 服务共用专用 Worker 镜像；最后再移除旧 Next 页面和路由。

**Tech Stack:** React/Vite/TypeScript，Go `net/http`，Node.js 24/TypeScript/Prisma 7，PostgreSQL/pgvector，Docker Compose，Vitest，Go test，Playwright。

**Spec:** `docs/superpowers/specs/2026-11-06-nextjs-retirement-requirements.md`

**当前状态（2026-11-06）：** Task 1–6 的代码与自动化验证已完成；Task 7 的本机启动、迁移、边缘路由和 Worker 验证已完成，真实管理员政策来源同步、双员工 SSO/飞书、财务复核及旧附件读取仍待现场验收。详细证据和待验收清单见 `docs/migration/nextjs-retirement-acceptance.md`。本计划尚未标记全部完成；代码已按任务分批提交，尚未推送。

## Global Constraints

- 顺序固定：政策来源管理入口 → Worker 构建 → 旧接口测试承接 → Next 专属代码与依赖退役 → 端到端验收。
- 保留 `public."Employee"`、Prisma Agent 数据和迁移、现有 Compose 项目名与命名卷；不得清理数据库或对象存储。
- 新管理入口只允许有效 Web SSO 会话且当前数据库角色为 `ADMIN` 的员工；`POLICY_ADMIN_FEISHU_OPEN_IDS` 不再自动授予权限。
- 政策同步继续异步入队；失败不替换活动快照，停用来源不再参与问答。
- 旧 `legacy-web` 可在过渡阶段留作显式回退，最终阶段删除；不能向公网重新开放旧写 API。
- 本计划不接入审批或付款，也不把 Node Agent、Prisma 或政策向量化迁入 Go。
- 执行时沿用当前 checkout；用户先前明确不希望为开发另建 worktree。每阶段通过后再进入下一阶段；不自动提交或推送。

## Review Focus

- 被撤销的 SSO 会话或已停用员工即使持有未过期 Bearer token，政策来源接口仍应拒绝；Task 2 加 Go 鉴权回归测试。
- 仅在旧政策白名单中、当前角色不是 `ADMIN` 的员工不得沿用管理权限；Task 1 产出逐人映射，Task 2 加 403 测试。
- 重复点击同步及 Worker 重启时，同一来源不出现多个竞争中的活动快照；Task 3 加入入队和任务状态测试。
- 文档授权/Embedding 故障后页面显示失败、历史索引仍可用，不能显示 `undefined` 切片；Task 3、4 分别覆盖服务与 UI。
- Agent 管理内网端口被直接请求、伪造员工头或缺少服务密钥时不能读写来源；Task 3 加 401/403 测试。

---

### Task 1：建立退役清单与角色迁移门槛

**Files:**
- Create: `docs/migration/nextjs-retirement-inventory.md`
- Inspect: `app/**`、`src/ui/**`、`src/server/**`、`tests/integration/api/**`、`tests/e2e/**`、`README.md`、`docs/operations.md`

**Interfaces:** 输出每条旧 URL/Route Handler、调用方、数据写入、现有 React/Go/Agent 替代、处置及对应测试的表格。此表是 Task 6 删除旧代码的准入清单。

- [ ] 列出 `app/` 下全部页面和 Route Handler，`rg -n 'app/api/|next/|/admin/policy-sources|/policies|POLICY_ADMIN_FEISHU_OPEN_IDS'` 查找调用方；另列外部深链、员工角色管理、政策规则、Web Agent 对话与旧审核入口。
- [ ] 对照 Go 路由、React 路由、Worker 引用及产品保留范围，为每项标注“已替代 / Task 2–4 迁移 / 确认退役”；无法证明替代的条目不得列入 Task 6 删除集合。
- [ ] 对照旧 `POLICY_ADMIN_FEISHU_OPEN_IDS` 和当前 `FEISHU_ADMIN_OPEN_IDS` / Go `ADMIN` 角色来源，记录需要显式授权的账号处理方式；不得把旧白名单并入新角色配置。
- [ ] 校验清单无“未知”项，并记录清单生成时的 `git rev-parse HEAD` 与路由数量；审阅该清单后再开始后续删除动作。

### Task 2：Go Auth BFF 增加政策来源受限转发

**Files:**
- Create: `services/reimbursement-api/internal/transport/http/policy_source_proxy.go`
- Create: `services/reimbursement-api/internal/transport/http/policy_source_proxy_test.go`
- Modify: `services/reimbursement-api/internal/transport/http/router.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`
- Modify: `docker-compose.yml`、`.env.example`（仅新增 `AGENT_ADMIN_SERVICE_KEY` 和内网地址的说明，不写真实值）

**Interfaces:** 浏览器使用 `GET/POST /api/v1/admin/policy-sources`、`PATCH /api/v1/admin/policy-sources/{sourceId}`、`POST /api/v1/admin/policy-sources/{sourceId}/sync`、`GET /api/v1/admin/policy-sources/{sourceId}/jobs/{jobId}`。Go 对每个请求要求 `Actor.Channel == "web"`、`Actor.Role == "ADMIN"`，并用现有 `AdminServices.Role(ctx,id)` 读取当前角色核对；代理仅将受限的 method/path/body、经认证的 actor ID 和专用服务密钥送往内网 Agent 管理服务。`AGENT_ADMIN_SERVICE_KEY` 与现有 Agent → Go 密钥分离。

- [ ] 在 `policy_source_proxy_test.go` 写失败测试：无会话 401、FINANCE_REVIEWER/EMPLOYEE/Agent bearer 403、当前角色变更后 403、SSO 撤销后 401；成功请求的上游头只能包含服务密钥与已验证 actor ID，不能透传浏览器伪造头或 Cookie。
- [ ] 运行 `go test ./internal/transport/http -run PolicySource -count=1`，确认因新路由/代理缺失而失败。
- [ ] 实现 `policySourceProxy`，配置上游 URL、短超时、请求体大小上限、允许方法和路径；上游不可达时返回安全的 503，不回显内网 URL、密钥或堆栈；接入路由和主程序依赖。
- [ ] 运行同一测试与 `go test ./...`；确认原有 Auth BFF、管理员复核路由无回归。

### Task 3：Agent 管理服务承接政策来源与任务状态

**Files:**
- Create: `src/server/agent-admin-http.ts`、`src/worker/agent-admin.ts`
- Create: `tests/integration/agent-admin-policy-sources.test.ts`
- Modify: `src/infrastructure/prisma/policy-knowledge-repository.ts`、`src/infrastructure/prisma/async-job-repository.ts`、`src/server/policy-source-response.ts`、`src/application/process-async-job.ts`、`src/application/run-async-job-worker.ts`
- Test: `tests/unit/application/run-async-job-worker.test.ts`、`tests/unit/application/sync-policy-source.test.ts`
- Modify: `prisma/schema.prisma` 与新增的 `prisma/migrations/<timestamp>_policy_source_audit/migration.sql`
- Modify: `docker-compose.yml`、`package.json`（添加服务启动命令，保留过渡期旧 Web）

**Interfaces:** Agent 内网对应 Task 2 的四组路径；统一返回 `{sources: PolicySourceView[]}`、`PolicySourceView`、`{sourceId,jobId,jobStatus}` 与 `{jobId,status,failureCode,resultKind}`。`PolicySourceView` 保持现有 `toPolicySourceResponse` 字段，增加 `lastJob: {jobId,status,failureCode,resultKind} | null`，不暴露飞书 token、政策全文或向量。`status` 使用现有 `AsyncJobStatus`，`resultKind` 仅为 `SYNCED | UNCHANGED | null`；将 `syncPolicySource` 的返回值写入现有 `AsyncJob.result`，任务读取必须验证所属 `sourceId`。持久审计表记录 actor ID、source ID、动作、结果、时间，不存敏感正文。Go 是当前角色的唯一授权来源；内网服务验证独立服务密钥与 Go 传入的非空 actor ID，不读取旧白名单或信任浏览器角色。

- [ ] 在集成测试写失败场景：缺/错 `AGENT_ADMIN_SERVICE_KEY`、缺少 Go 传入的 actor ID、非法/重复飞书链接、停用来源同步、跨来源 job ID、重复入队、失败后活动快照保持、审计事件；普通员工角色的拒绝由 Task 2 的 Go 测试覆盖。保留旧 `parsePolicySourceUrl` 的边界测试。
- [ ] 运行 `npx vitest run tests/integration/agent-admin-policy-sources.test.ts`，确认缺少新服务时失败。
- [ ] 实现 Node HTTP 入口与服务层：常量时间校验专用密钥，仅接受 Go 代理传来的 actor ID；复用 `parsePolicySourceUrl`、`PrismaPolicyKnowledgeRepository`、`PrismaAsyncJobRepository`。读任务只返回白名单字段；为新建/启停/同步及结果写审计，迁移保持既有历史数据不变。
- [ ] 将政策同步的 `SYNCED`/`UNCHANGED` 结果传到 `runAsyncJobWorkerOnce`，在成功状态更新时写入现有 `AsyncJob.result`；OCR 任务继续按原路径处理。加测试验证 `UNCHANGED`、失败重试和 Worker 重启后仍可读出正确状态。
- [ ] 运行该集成测试与 `tests/unit/domain/policy-source.test.ts`、`tests/unit/application/sync-policy-source.test.ts`；确认文档无权限、Embedding 故障及 `UNCHANGED` 的任务状态可被安全展示。

### Task 4：React 接管政策来源管理页面

**Files:**
- Create: `apps/web/src/routes/policy-sources-page.tsx`、`apps/web/src/routes/policy-sources-page.test.tsx`
- Modify: `apps/web/src/app.tsx`、`apps/web/src/api/client.ts`、`apps/web/src/routes/policy-rules-page.tsx`
- Modify: `apps/web/src/styles.css`（仅该页必需样式，实际样式文件执行时先核对）

**Interfaces:** `reimbursementApi` 新增 `listPolicySources()`、`createPolicySource({title,url})`、`setPolicySourceEnabled(sourceId,enabled)`、`syncPolicySource(sourceId)`、`getPolicySourceJob(sourceId,jobId)`，沿用现有 Bearer token/401 刷新约定。页面位于 `/admin/policy-sources`，由当前 React 管理导航可达。

- [ ] 写组件测试：加载/空状态、添加 Docx/Wiki、启停、同步排队到成功/未变化/失败、刷新后恢复任务状态、401/403/503、失败但保留上次索引、缺失切片数、可访问的表单标签和按钮禁用态。
- [ ] 运行 `cd apps/web; npx vitest run src/routes/policy-sources-page.test.tsx`，确认因组件/客户端方法不存在而失败。
- [ ] 实现页面与 API 客户端；同步后以 job ID 查询状态，刷新时从来源的最近任务摘要恢复，轮询设上限并在卸载时停止；只在 `SUCCEEDED` 且有数值时显示切片数，失败原因用现有分类映射，原文链接 `rel="noopener noreferrer"`。
- [ ] 运行目标测试、`cd apps/web; npx tsc --noEmit`、`cd apps/web; npm run build`；在旧 Next 服务停止时通过新页面完成一次读/写/同步接口冒烟。

### Task 5：四个 Node 服务切换到专用 Worker 镜像

**Files:**
- Modify: `Dockerfile`、`docker-compose.yml`、`.dockerignore`
- Create: `services/worker-runtime/package.json`、`services/worker-runtime/package-lock.json`（独立运行依赖锁文件）
- Modify: `tests/integration/docker-worker-compose.test.ts`

**Interfaces:** 同一 `worker-runtime` 镜像供 `feishu-bot-worker`、`job-worker`、`agent-event-worker`、`alert-relay` 及 Task 3 Agent 管理服务使用；保留 `scripts/docker-runtime.mjs`、`tsx`、根 `tsconfig.json` 路径别名与 Prisma Client。过渡期旧 `web` 另用 `legacy-web` 构建目标，不影响默认 Worker 构建。

- [ ] 记录本机同缓存基线：四服务 `docker compose build` 的耗时、`docker image inspect` 大小与 Dockerfile 构建步骤；记录命令和结果到 `docs/migration/nextjs-retirement-inventory.md`，不把密钥或完整日志写入仓库。
- [ ] 扩展 Compose 测试，先断言 Worker 构建目标、运行镜像无 `.next`/`public`/Next 包，`tsx`、Prisma Client、路径别名、密钥入口、四个进程命令与现有心跳配置仍有效；运行目标测试确认失败。
- [ ] 将 Dockerfile 拆为 `legacy-web` 与 `worker-runtime` 目标；Worker 依赖从独立且提交锁文件的 `services/worker-runtime` 安装，仅复制运行所需代码/生成客户端；为 Agent 管理服务配置内网 `expose`，不映射宿主端口。Compose 的四个 Node 服务显式指向 `worker-runtime`。
- [ ] 运行目标测试、`docker compose build feishu-bot-worker job-worker agent-event-worker alert-relay agent-admin`、逐个进程启动/健康与关键日志冒烟；检查镜像内 `test ! -d /app/.next`、`require.resolve('next')` 失败、`tsx` 和 Prisma Client 可加载。
- [ ] 在相同主机/缓存条件下记录改后构建时间与镜像大小；若依赖缺失或路径别名失败，先修正 Worker 依赖清单，不回退到整包复制。

### Task 6：承接旧断言并删除 Next 专属代码

**Files:**
- Modify: `tests/integration/api/**`、`tests/contract/**`、`tests/e2e/**` 中直接导入旧 Route Handler 的用例（按 Task 1 清单逐项处置）
- Modify: `.github/workflows/ci.yml`、`package.json`、`package-lock.json`、`tsconfig.json`、`eslint.config.mjs`、`playwright.config.ts`、`docker-compose.yml`、`Dockerfile`
- Delete after gates: `app/**`、已证实仅供 Next 使用的 `src/ui/**`、`src/server/**`、`public/**` 与旧 Web 配置

**Interfaces:** 当前产品行为的旧断言移到 Go HTTP/领域测试、Agent 管理服务测试或 React 页面测试；仅确认退役的旧行为删除专属测试。根包保留 Node Agent/Worker/Prisma 所需依赖与测试工具，移除 `next`、`eslint-config-next`、根包无实际使用的 `react`/`react-dom` 与 Next `dev/build/start` 脚本。

- [ ] 按 Task 1 清单建立“旧测试文件 → 新测试/明确退役”映射，先补齐缺失的 Go/React/Agent 回归测试并运行；身份、提交、OCR、复核和政策搜索的保留断言必须有对应验证。
- [ ] 在静态契约测试写删除前的失败断言：生产路径无 `next/*` 与 `app/**` 引用、Compose 无 `legacy-web`、CI 无 `next build`、根依赖无 Next；运行确认失败。
- [ ] 清理仅由旧 Next 引用的代码和资产，移除 `legacy-web`、Next 脚本/依赖/配置；保留 Prisma schema/历史迁移、`public."Employee"`、Worker 调用的 `src/application` / `src/domain` / `src/infrastructure` 与当前运维脚本。
- [ ] 更新 CI：根 Node 任务执行 Prisma generate/migrate、lint、tsc、适用测试和 Worker 镜像构建；React/Go 原有门槛维持。运行 `npm ci`、`npm test`、`npm run lint`、`npx tsc --noEmit`、React 测试/构建、`go test ./...`、`docker compose config` 和目标静态契约测试。
- [ ] 以全量 `rg` 和镜像检查确认无生产 Next 引用；若 Task 1 有尚未替代的唯一操作或外部深链，暂停相应删除，先补入口或明确退役响应。

### Task 7：文档更新和真实平台最终验收

**Files:**
- Modify: `README.md`、`docs/operations.md`、`.env.example`、`docs/migration/nextjs-retirement-inventory.md`
- Create: `docs/migration/nextjs-retirement-acceptance.md`

**Interfaces:** 记录实际镜像版本、验证环境、两名员工的非敏感标识、单号/任务 ID、预期与实际状态及日志关联 ID；不写密钥、票据原文或完整会话。

- [ ] 更新启动/停止、路由、密钥边界、政策管理与任务状态、Worker 故障排查；移除指向 `localhost:3000`、`legacy-web` 和旧 Next API 的现行操作说明，历史设计文档保留历史标识。
- [ ] 在不删除卷的前提下启动当前 Compose，核对 Nginx 只把页面交 React、API 交 Go，Agent 管理服务无外部端口；两名企业成员分别测登录、单据、飞书、退出及跨员工拒绝。
- [ ] 现场测管理员来源登记/同步/政策问答引用/规则发布、财务票据复核、员工上传/OCR/提交；再测文档无权限、Embedding 不可用、Worker 重启/重复同步，确认历史快照与幂等性。
- [ ] 记录 CI 结果、Worker 镜像无 Next 包/`.next`、`docker compose config`、服务日志与恢复步骤；确认已有数据库和 MinIO 数据仍可读取，且无旧 Next 写入口。
- [ ] 按 Task 1 清单逐项关闭处置状态。只有全部自动化与现场验收通过后，才标记本计划完成；若真实飞书/SSO 环境不可用，保留为待验收并准确记录阻碍。
