# Next.js 退役清单

基线：`57dd141d7de0da7c320d71111b6c6f009035bf9e`（2026-11-06，`master`）。当前 `app/api` 有 38 个 Route Handler，`app/(authenticated)` 有 8 个页面。下表以旧 URL 为单位；“退役”表示不再提供该旧契约，不表示删除仍供 Worker 使用的领域代码或历史数据。

## 页面和入口

| 旧页面 | 新入口或处置 | 验证归属 |
| --- | --- | --- |
| `/` | React `/claims` | React 路由 / E2E |
| `/claims` | React `/claims` + Go 列表查询 | React / Go |
| `/claims/new` | React `/claims/new` + Go 创建 | React / Go |
| `/claims/{claimId}` | React 同路径 + Go 详情/票据/提交 | React / Go |
| `/claims/{claimId}/detail` | 旧详情深链退役；需要明确迁往 `/claims/{claimId}`，不可静默显示成功 | React 路由 |
| `/admin/policies` | React 同路径 + Go 发布规则；旧草稿版本编辑契约不再作为当前入口 | React / Go |
| `/admin/policy-sources` | Task 2–4 补 React + Go 受限代理 + Agent 管理服务 | React / Go / Agent |
| `/admin/reviews` | React 同路径 + Go 财务复核 | React / Go |
| `/policies` | 旧员工政策页退役；政策问答由飞书 Agent 提供，深链应明确提示停用 | React 路由或边缘路由 |

## API Route Handlers

| 旧方法和路径 | 处置 | 保留断言归属 |
| --- | --- | --- |
| `PATCH /api/admin/employees/{employeeId}/role` | 退役；Go Auth BFF 在 SSO 登录时按 `FEISHU_ADMIN_OPEN_IDS` / `FEISHU_FINANCE_REVIEWER_OPEN_IDS` 授权；当前无运行时角色管理 UI | Go Auth BFF 角色/停用测试 |
| `GET, POST /api/admin/policies` | 旧政策草稿列表/创建退役；当前 React/Go 仅支持规则发布 | Go 发布规则、React 页面测试 |
| `GET /api/admin/policies/{policyVersionId}` | 旧版本详情契约退役 | Go 政策执行/版本测试 |
| `PUT /api/admin/policies/{policyVersionId}/rules` | 旧草稿规则编辑契约退役 | Go 发布规则测试 |
| `POST /api/admin/policies/{policyVersionId}/publish` | Go `POST /api/v1/admin/policies/publish` 承接当前发布操作 | Go 管理路由测试 |
| `GET, POST /api/admin/policy-sources` | Task 2–4 迁入 `/api/v1/admin/policy-sources` | Agent 服务 + Go 代理测试 |
| `PATCH /api/admin/policy-sources/{sourceId}` | Task 2–4 迁入 `/api/v1/admin/policy-sources/{sourceId}` | Agent 服务 + Go 代理测试 |
| `POST /api/admin/policy-sources/{sourceId}/sync` | Task 2–4 迁入 `/api/v1/admin/policy-sources/{sourceId}/sync` | Agent 任务测试 |
| `GET /api/admin/reviews` | Go `GET /api/v1/admin/reviews` | Go 复核测试 |
| `POST /api/admin/reviews/{reviewId}/claim` | Go 同名 `/api/v1` 路径 | Go 复核测试 |
| `POST /api/admin/reviews/{reviewId}/resolve` | Go 同名 `/api/v1` 路径 | Go 复核测试 |
| `POST /api/admin/reviews/{reviewId}/retry` | 旧 Next 异步任务重试契约退役；Go 复核中心用重新上传/更正/关闭动作 | Go 复核测试 |
| `GET /api/auth/access-token` | Go Auth BFF 同路径 | Go Auth BFF 测试 |
| `POST /api/auth/dev-login` | 旧开发登录退役；正式主路径仅 SSO | Go Auth BFF 测试 |
| `GET /api/auth/feishu/login` | 旧 OAuth 退役；SSO 登录 `/api/auth/sso/login` | Go Auth BFF 测试 |
| `GET /api/auth/feishu/callback` | 旧 OAuth 回调退役；SSO 回调 `/api/auth/sso/callback` | Go Auth BFF 测试 |
| `POST /api/auth/logout` | 旧退出退役；Go `/api/auth/sso/logout` | Go Auth BFF 测试 |
| `GET /api/auth/session` | 旧会话查询退役；Go `/api/auth/access-token` | Go Auth BFF 测试 |
| `GET /api/auth/sso/login` | Go 同路径 | Go Auth BFF 测试 |
| `GET /api/auth/sso/callback` | Go 同路径 | Go Auth BFF 测试 |
| `GET /api/auth/sso/logout` | Go 同路径 | Go Auth BFF 测试 |
| `POST /api/auth/sso/backchannel-logout` | Go 同路径 | Go Auth BFF 测试 |
| `GET, POST /api/claims` | Go `/api/v1/claims` | Go Claim 测试 |
| `GET /api/claims/{claimId}` | Go `/api/v1/claims/{claimId}` | Go Claim 测试 |
| `GET /api/claims/{claimId}/detail` | Go Claim/receipt 详情组合；旧独立契约退役 | Go Claim/receipt 测试 |
| `POST /api/claims/{claimId}/fields` | Go `PATCH /api/v1/claims/{claimId}` | Go Claim 测试 |
| `POST /api/claims/{claimId}/receipts` | Go 上传会话 + finalize；旧单请求上传契约退役 | Go 票据测试 |
| `POST /api/claims/{claimId}/receipts/{receiptId}/extract` | Go 异步 OCR 流程；旧同步触发契约退役 | Go 票据 Worker 测试 |
| `GET /api/claims/{claimId}/validate` | Go `/api/v1/claims/{claimId}/validation` | Go 校验测试 |
| `POST /api/claims/{claimId}/submission-request` | Go `/api/v1/claims/{claimId}/submission-requests` | Go 提交测试 |
| `POST /api/claims/{claimId}/submit` | Go `/api/v1/claims/{claimId}/submit` | Go 提交测试 |
| `POST /api/claims/{claimId}/chat` | 旧单据内网页对话退役；飞书 Agent 私聊独立于单据 | 飞书 Agent 测试 |
| `POST /api/claims/{claimId}/agent-proposals/{proposalId}/accept` | 旧网页对话提议退役；当前 React 不提供 Agent 对话入口 | 飞书 Agent 工具调用测试 |
| `POST /api/claims/{claimId}/agent-proposals/{proposalId}/reject` | 同上 | 飞书 Agent 工具调用测试 |
| `GET /api/conversations/private` | 旧网页私聊退役；飞书 Agent 会话保留在 Prisma | 飞书会话仓储测试 |
| `POST /api/conversations/private/messages` | 同上 | 飞书 Agent 对话测试 |
| `POST /api/conversations/private/attachments` | 同上 | 飞书票据流程测试 |
| `GET /api/policies/current` | 旧网页政策版本展示退役；Go 当前政策校验与飞书政策问答保留 | Go 政策/Agent RAG 测试 |

## 源码、资产和测试

- `src/ui/*` 共 12 个文件，均为旧 Next 页面组件或 Hooks；退役前用反向导入扫描确认没有 Worker 引用。React 对应组件位于 `apps/web/src/routes`，不能从旧目录直接搬用 Next `Link`/Cookie。
- `src/server/*` 共 16 个文件。`config.ts`、`alert-relay-config.ts`、`policy-source-response.ts` 由 Worker 或新 Agent 服务使用，保留；其余按 Task 6 反向引用清理，不能仅凭目录批量删除。`review-admin.ts` 直接依赖 `next/server`。
- `src/application/*`、`src/domain/*`、`src/infrastructure/prisma/*` 仍服务于 Agent/知识库/任务；保留实际引用及其测试。Prisma schema 和全部旧迁移保留，尤其 `public."Employee"`。
- `app/globals.css`、页面局部 CSS、`public/*`、`next.config.*` 仅在完成静态引用核对后删除。根 `Dockerfile`/`package.json`/`tsconfig.json`/`eslint.config.mjs`/CI 的 Next 配置归 Task 5–6。
- `tests/integration/api/*` 共 20 个文件，逐项迁至 Go、React 或 Agent 直接契约测试；`tests/e2e/*` 共 4 个文件，按业务归属迁至 React E2E 或政策来源新入口；不得整目录跳过。
- 既有 Compose 项目名/卷、Go `reimbursement.employees` 与 Prisma `public."Employee"` 映射、异步任务和政策活动快照不随页面退役清理。

## 身份和深链处置门槛

- 旧 `POLICY_ADMIN_FEISHU_OPEN_IDS` 是 Next 专用权限；新入口只认 Go Auth BFF 当前 `ADMIN`。旧白名单账号如未在 `FEISHU_ADMIN_OPEN_IDS` 显式授权，访问新入口应为 403。不能自动合并两份名单，也不能在清单中记录实际 `open_id`。
- 旧 `localhost:3000` 不是当前公开主入口；历史飞书消息可能仍带旧链接。Task 6 前检查运行配置和文档中是否仍生成这些链接；不能把 `/policies` 或旧详情深链静默导向另一个成功页面。
- 本文件的“退役”判断依赖当前已确认的产品范围：React 不提供网页 Agent 对话入口，真实审批/付款暂不支持。若发现实际外部调用方，先补受控替代或明确停用响应，再删代码。

## 阶段记录

Worker 构建基线（2026-11-06，本机 Docker Desktop、已有缓存）：`docker compose --env-file .env.local --profile migration --profile observability build feishu-bot-worker job-worker agent-event-worker alert-relay agent-admin` 耗时 152.8 秒；`reimbursement-sso-feishu-bot-worker` 镜像为 367,989,535 字节。旧构建先对根包执行 `npm ci`、`prisma generate`、`next build`，再将 `.next`、`public` 和根 `node_modules` 复制到每个 Worker 镜像。此基线是本机缓存状态下的观测值，不等同于冷构建或 CI 时间。

同机改后首次构建耗时 121.3 秒；发现 Prisma CLI 的可选 peer 依赖会把 React 带进运行镜像，改为单独执行 `npm ci --omit=dev --omit=peer` 的运行依赖阶段后，再次构建耗时 127.8 秒，镜像为 180,634,288 字节。后续完整重建后的实际镜像为 180,452,368 字节。镜像内检查：无 `.next`、`public`、`next`、`react`；`tsx`、Prisma Client、adapter 和生成客户端均存在。最终镜像大小比基线减少 187,537,167 字节（约 51%）；构建耗时受缓存影响，只记录观测值，不作为性能保证。

### 旧测试断言归属

| 旧测试文件 | 当前归属或退役依据 |
| --- | --- |
| `tests/integration/api/{sso-login,sso-logout,sso-backchannel,session,auth-access-token,dev-login,feishu-login}.test.ts` | Go Auth BFF 的 `auth_bff_test.go`、`sso_session_test.go` 覆盖当前 SSO 登录、身份、回调、退出、撤销；旧 Feishu OAuth 和开发登录已退役 |
| `tests/integration/api/{claims,claim-detail,claim-fields,expense-fields,claim-validation}.test.ts` | Go `claims_handler_test.go`、`claim_service_test.go`、`claim_search_test.go`、`policy_rules_test.go` 覆盖本人范围、字段、校验和提交；旧 Next 存储接口退役 |
| `tests/integration/api/{receipt-upload,review-routes}.test.ts` | Go `claims_handler_test.go`、`extract_receipt_test.go`、`postgres_review_case_repository_test.go` 与 React `review-center-page.test.tsx` 覆盖上传、OCR 与复核；旧 Next 审核队列退役 |
| `tests/integration/api/{policy-admin-routes,policy-source-routes}.test.ts` | Go 政策规则发布测试、Go 管理代理测试、Agent 管理服务集成测试、React 政策来源页测试覆盖现行行为；旧 Next 草稿版本编辑退役 |
| `tests/integration/api/{conversation-routes,claim-chat,agent-proposal-routes}.test.ts` | 旧网页 Agent 对话入口明确退役；现行飞书 Agent 由 `agent-live-go-feishu-flow.test.ts`、工具网关与会话测试覆盖 |
| `tests/integration/api/request-correlation.test.ts` | Go HTTP 请求中间件与现行链路日志测试承接；旧 Next 响应测试退役 |
| `tests/integration/{claim-submission,receipt-duplicate}.test.ts` | Go 提交快照、政策警告、重复票据和异步 OCR 测试承接；旧 Next Route Handler 测试退役 |
| `tests/unit/ui/*` | React `apps/web/src/routes`、`apps/web/src/features` 的当前表单/上传/复核测试承接；网页 Agent、小球与旧组件逻辑退役 |
| `tests/e2e/{claim-submission,agent-confirmation,policy-management,policy-source-management}.spec.ts` | React `apps/web/e2e/claim-submission.spec.ts` 和页面测试承接当前入口；旧网页 Agent 与 Next 草稿政策操作退役，政策来源由新 React 页测试与现场冒烟承接 |

上述映射区分“当前产品的行为由新实现测试覆盖”和“旧契约明确退役”；不声称旧测试逐项移植到新技术栈。财务复核、身份、提交、OCR 和政策检索仍需通过各自模块测试及最终现场链路验收。

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| Task 1 清单 | 已建立 | 本文件及上述基线、路由数量、归属映射 |
| Task 2–4 管理入口 | 已实现，现场写入/同步待验收 | Go/Agent/React 测试通过；未登录新 API 401，旧 API 404 |
| Task 5 Worker 镜像 | 已完成 | 构建、进程心跳、运行依赖与镜像内容检查通过 |
| Task 6 旧测试和 Next 清理 | 已完成 | 旧断言归属映射、Node/React/Go 测试、静态引用与 CI 配置检查 |
| Task 7 现场验收 | 进行中 | 见 `nextjs-retirement-acceptance.md`；真实管理员及双员工链路待验收 |
