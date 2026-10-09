# 统一飞书身份链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书个人 OAuth、React Web、Go 报销 API 与飞书 Agent 使用同一员工身份和可验证的短期 JWT。

**Architecture:** 现有 Next.js 作为轻量 Auth BFF，继续处理飞书 OAuth 和 HttpOnly 会话，并签发 15 分钟 Web JWT。Go API 根据 `channel` 区分 Web 与 Agent Token；Auth BFF/Agent 以独立 Provisioning Key 幂等同步 Go 员工投影。

**Tech Stack:** Next.js 15、TypeScript、Vitest、React 19/Vite/TanStack Query、Go 1.27、`net/http`、`pgx/v5`、PostgreSQL、Docker Compose、Nginx。

**Spec:** `docs/superpowers/specs/2026-10-07-unified-feishu-identity-design.md`

## Global Constraints

- 仅使用飞书 app-scoped `open_id` 绑定账号；禁止把授权码、飞书 Token、client secret、应用 JWT 写入 URL、浏览器持久化存储、审计或日志。
- `REIMBURSEMENT_AUTH_HS256_SECRET` 与 `SESSION_SECRET` 必须独立；JWT 固定为 HS256、`aud=reimbursement-api`、TTL 15 分钟。
- 浏览器 Token 仅保存在 React 内存；Cookie 保持 HttpOnly、SameSite=Lax，生产环境加 Secure。
- Web Token 必须是 `channel=web`；Agent Token 必须是 `channel=agent`、有 `jti` 且附带 `X-Agent-Service-Key`；二者不可混用。
- 角色只来自 `FEISHU_ADMIN_OPEN_IDS` 与 `FEISHU_FINANCE_REVIEWER_OPEN_IDS`；交叉配置导致启动失败，未命中者为 `EMPLOYEE`。
- `PUT /internal/v1/employees/{employeeId}` 仅私网可用且只接受 `X-Auth-Provisioning-Key`；禁止复用 Agent 服务密钥。
- 同步员工失败时不得签发 JWT 或执行 Agent 报销工具调用；Token 刷新后的写重试必须复用原 `Idempotency-Key` 且仅一次。
- 不接企业 SSO、SCIM、LDAP、角色后台管理，也不迁移旧测试数据。

## Review Focus

- `returnTo` 是 `//host`、协议 URL、反斜杠或编码绕过时，必须回退 `/claims`。（Task 4）
- 两个角色白名单出现相同 `open_id` 时，服务必须拒绝启动。（Task 1）
- 篡改 `aud`、`channel`、`role`、`jti`、签名或过期时间的 Token 必须被 Go 拒绝。（Task 2）
- Provisioning Key 缺失、错误或换成 Agent Service Key 时，员工同步必须拒绝；公网代理也不可访问。（Task 3、7）
- Web 写请求 Token 过期后使用相同幂等键重试一次；第二次 401 不得循环或重复写入。（Task 6）

---

## File Structure

| 路径 | 责任 |
|---|---|
| `src/server/reimbursement-auth.ts` | BFF 角色解析、JWT 签发、签名配置校验与安全 return path。 |
| `src/application/ensure-employee-identity.ts` | 复用 Prisma 员工绑定，并驱动 Go 投影同步。 |
| `src/infrastructure/reimbursement/employee-provisioning-client.ts` | 调用私网 Go 员工同步 API。 |
| `app/api/auth/access-token/route.ts` | 从 Cookie 会话返回短期 Web JWT。 |
| `services/reimbursement-api/internal/application/employee_identity.go` | Go 员工投影 Upsert 服务。 |
| `services/reimbursement-api/internal/store/employee_identity_repository.go` | `reimbursement.employees` 幂等 Upsert。 |
| `services/reimbursement-api/internal/transport/http/internal_employee_handler.go` | Provisioning Key 保护的内部 Handler。 |
| `apps/web/src/auth/session.ts` | React 内存 Token、刷新、单次重试与登出。 |
| `infra/nginx/reimbursement-routes.conf` | 公网只发布 `/`、`/api/auth/*`、`/api/v1/*`，拒绝 `/internal/*`。 |

### Task 1: Auth BFF 角色与 JWT 合同

**Files:**
- Create: `src/server/reimbursement-auth.ts`
- Create: `tests/unit/server/reimbursement-auth.test.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `services/reimbursement-api/docker-entrypoint.sh`

**Interfaces:**
- Produces `resolveFeishuRole(openID, env): EmployeeRole`, `validateRoleConfiguration(env): void`, `createReimbursementJwt(input, secret, now?): string`, `parseSafeReturnTo(value): string`.
- `input` contains subject, role, channel and optional JTI; audience is fixed to `reimbursement-api`.

- [ ] **Step 1: Write failing Vitest cases**

In `tests/unit/server/reimbursement-auth.test.ts`, cover admin/finance/default role, overlapping lists, 900-second JWT TTL and required fields, Agent JTI requirement, and hostile return paths.

- [ ] **Step 2: Verify failure**

Run `npm test -- tests/unit/server/reimbursement-auth.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement the contract helpers**

Use Node `crypto` HMAC-SHA256 and base64url. Parse comma-separated lists with trim/dedupe; reject non-empty intersections. Accept only a one-slash relative `returnTo` path.

- [ ] **Step 4: Make configuration explicit**

Add both role lists and `REIMBURSEMENT_AUTH_PROVISIONING_KEY` to `.env.example`. Retain existing Compose secret injection. Remove the Go entrypoint fallback from `SESSION_SECRET` to `REIMBURSEMENT_AUTH_HS256_SECRET`.

- [ ] **Step 5: Verify and commit**

Run `npm test -- tests/unit/server/reimbursement-auth.test.ts tests/unit/server/session.test.ts tests/unit/server/auth-cookies.test.ts`; expect PASS. Commit with `feat: define unified reimbursement auth contract`.

### Task 2: Go Web/Agent JWT Boundary Enforcement

**Files:**
- Modify: `services/reimbursement-api/internal/transport/http/auth_middleware.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `services/reimbursement-api/internal/transport/http/admin_handler.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`

**Interfaces:**
- Consumes Task 1 claims.
- Extends `Actor` to ID, Role and Channel.
- Produces a Web resolver requiring `channel=web`; delegated Agent resolver retains its key and requires `channel=agent` + JTI.

- [ ] **Step 1: Write failing Go tests**

Add cases for valid Web Token, Agent Token without Agent key, Web Token with Agent key, missing/wrong channel, wrong audience, altered signature, unknown role and expired Token. Add privileged-route coverage where signed role differs from stored role and assert `403`.

- [ ] **Step 2: Verify failure**

Run `docker run --rm -v "${PWD}:/src" -w /src/services/reimbursement-api golang:1.27.1-alpine go test ./internal/transport/http -run 'Test(HS256|Delegated|Web|Admin)' -count=1`. Expected: existing resolver accepts claims without Web channel.

- [ ] **Step 3: Implement typed resolvers**

Parse all signed claims once after HMAC verification. Reject unknown roles. Require active employee, Agent key, `channel=agent`, JTI for delegated traffic. Keep `StaticActorResolver` only when `REIMBURSEMENT_DEV_AUTH=true`.

- [ ] **Step 4: Apply dual role checks to admin routes**

Require both `Actor.Role` and current `reimbursement.employees.role`. `ADMIN` may publish/resolve; `FINANCE_REVIEWER` may resolve only. Return stable `FORBIDDEN` only.

- [ ] **Step 5: Verify and commit**

Run `docker run --rm -v "${PWD}:/src" -w /src/services/reimbursement-api golang:1.27.1-alpine go test ./internal/transport/http -count=1`; expect PASS. Commit with `feat: enforce web and agent token boundaries`.

### Task 3: Go Private Employee Provisioning API

**Files:**
- Create: `services/reimbursement-api/internal/application/employee_identity.go`
- Create: `services/reimbursement-api/internal/application/employee_identity_test.go`
- Create: `services/reimbursement-api/internal/store/employee_identity_repository.go`
- Create: `services/reimbursement-api/internal/store/employee_identity_repository_test.go`
- Create: `services/reimbursement-api/internal/transport/http/internal_employee_handler.go`
- Modify: `services/reimbursement-api/internal/transport/http/router.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`

**Interfaces:**
- Produces `EmployeeIdentityService.Upsert(ctx, EmployeeIdentityCommand) error`.
- Produces `PUT /internal/v1/employees/{employeeId}`, with `displayName`, `feishuOpenId`, `role`, `isActive` body fields.

- [ ] **Step 1: Write failing application and HTTP tests**

Cover employee create, idempotent repeat update, role/display-name update, blank fields/unknown role rejection, existing foreign open-ID conflict, valid Provisioning Key success and missing/wrong/Agent key failure.

- [ ] **Step 2: Verify failure**

Run `docker run --rm -v "${PWD}:/src" -w /src/services/reimbursement-api golang:1.27.1-alpine go test ./internal/application ./internal/transport/http -run 'Test(EmployeeIdentity|InternalEmployee)' -count=1`. Expected: service/handler absent.

- [ ] **Step 3: Implement transactional Upsert and isolated internal route**

Use `INSERT ... ON CONFLICT (id) DO UPDATE` to update display name, open ID, role and active state atomically. Do not overwrite an open ID already bound to another ID. Register the internal handler outside public `Authenticate`; compare Provisioning Key in constant time.

- [ ] **Step 4: Wire runtime configuration**

Require the Provisioning Key on non-development Go startup. Do not list the endpoint in public OpenAPI and preserve existing `/api/v1/*` authentication.

- [ ] **Step 5: Verify and commit**

Run `docker run --rm -v "${PWD}:/src" -w /src/services/reimbursement-api golang:1.27.1-alpine go test ./internal/application ./internal/store ./internal/transport/http -count=1`; expect PASS. Commit with `feat: add private reimbursement employee provisioning`.

### Task 4: Auth BFF Identity Ensure, OAuth Return Path and Access Token API

**Files:**
- Create: `src/application/ensure-employee-identity.ts`
- Create: `src/infrastructure/reimbursement/employee-provisioning-client.ts`
- Create: `app/api/auth/access-token/route.ts`
- Modify: `app/api/auth/feishu/login/route.ts`
- Modify: `app/api/auth/feishu/callback/route.ts`
- Modify: `app/api/auth/dev-login/route.ts`
- Modify: `src/server/auth-cookies.ts`
- Modify: `tests/unit/application/authenticate-feishu-user.test.ts`
- Modify: `tests/integration/api/feishu-login.test.ts`
- Create: `tests/integration/api/auth-access-token.test.ts`

**Interfaces:**
- Produces `ensureEmployeeIdentity(input, deps): Promise<ResolvedEmployeeIdentity>` with employee ID, display name, open ID, role and active state.
- Produces `GET /api/auth/access-token` response `{ accessToken, expiresAt, employee }` or stable 401/503.

- [ ] **Step 1: Write failing BFF tests**

Cover first/existing open-ID binding, computed role sent to provisioning, provisioning failure preventing JWT, permitted/malicious callback return path, valid session refresh and response secrecy.

- [ ] **Step 2: Verify failure**

Run `npm test -- tests/unit/application/authenticate-feishu-user.test.ts tests/integration/api/feishu-login.test.ts tests/integration/api/auth-access-token.test.ts`. Expected: ensure service and access-token route absent.

- [ ] **Step 3: Implement reusable identity ensure service**

Leave `authenticateFeishuUser` responsible only for Prisma binding. Compose it with Task 1 role resolution and a provisioning HTTP client carrying `X-Auth-Provisioning-Key`. Convert network/non-2xx results to `IDENTITY_PROVISIONING_UNAVAILABLE` without logging credentials or open IDs.

- [ ] **Step 4: Update OAuth and dev login**

Persist a short-lived HttpOnly return-path Cookie beside OAuth state. Successful callback ensures the employee projection, issues current session Cookie, clears temporary cookies and redirects safely. Dev login performs identical provisioning first; a provisioning error returns 503 and writes no session.

- [ ] **Step 5: Implement access-token refresh endpoint**

Read session Cookie, load employee binding, re-ensure projection and issue a Web JWT. Set `Cache-Control: no-store`; return 401 for bad session and `503 IDENTITY_PROVISIONING_UNAVAILABLE` for sync failure.

- [ ] **Step 6: Verify and commit**

Run `npm test -- tests/unit/server/reimbursement-auth.test.ts tests/unit/application/authenticate-feishu-user.test.ts tests/integration/api/feishu-login.test.ts tests/integration/api/auth-access-token.test.ts tests/integration/api/session.test.ts`; expect PASS. Commit with `feat: issue Go API tokens from Feishu sessions`.

### Task 5: Agent First-Contact Identity Provisioning

**Files:**
- Modify: `src/application/process-feishu-event.ts`
- Modify: `src/infrastructure/prisma/feishu-bot-repository.ts`
- Modify: `src/worker/feishu-bot.ts`
- Modify: `tests/unit/application/process-feishu-event.test.ts`
- Modify: `tests/integration/feishu-bot-worker.test.ts`
- Modify: `services/agent/src/ports/reimbursement-port.ts`
- Modify: `services/agent/src/ports/reimbursement-port.test.ts`

**Interfaces:**
- Replaces event-path lookup with `ensureEmployeeForInboundMessage({ openId, displayName? })`.
- Agent Token contract includes fixed audience, `channel=agent`, JTI, employee ID, conversation ID and tool-call ID.

- [ ] **Step 1: Write failing Agent tests**

Replace the unknown-sender `LOGIN_REQUIRED` assertion with successful first contact after ensure returns `employee-1`. Cover provisioning failure as a generic retryable reply with no conversation/tool invocation. Assert Agent Token fields and that actor ID comes only from trusted ToolCallContext.

- [ ] **Step 2: Verify failure**

Run `npm test -- tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-worker.test.ts && npm --prefix services/agent test -- src/ports/reimbursement-port.test.ts`. Expected: current path sends an OAuth login link.

- [ ] **Step 3: Implement common identity ensure in the Worker**

Create/reuse Prisma employee by sender open ID, invoke provisioning before conversation creation, and continue the normal turn only on success. Do not reveal provisioning error, open ID or internal URL in Feishu replies.

- [ ] **Step 4: Align Agent JWT generation**

Keep Agent service-key behavior; centralize typed Token claim construction in the reimbursement port and avoid logging signed tokens.

- [ ] **Step 5: Verify and commit**

Run `npm test -- tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-worker.test.ts tests/unit/worker/feishu-bot-runtime.test.ts && npm --prefix services/agent test`; expect PASS. Commit with `feat: provision Feishu bot users before reimbursement actions`.

### Task 6: React In-Memory Session, Refresh and Stable Retry

**Files:**
- Create: `apps/web/src/auth/session.ts`
- Create: `apps/web/src/auth/session.test.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/vite-env.d.ts`

**Interfaces:**
- Produces `AuthSessionProvider`, `useAuthSession()`, `getAccessToken()`, `refreshAccessToken()` and `logout()`.
- API client receives a TokenProvider and reuses one idempotency key across its only retry.

- [ ] **Step 1: Write failing React tests**

Cover valid startup token, initial 401 OAuth redirect, pre-expiry refresh, logout clearing memory, first 401 mutation refresh with identical Idempotency-Key, and second 401 rejection without loop.

- [ ] **Step 2: Verify failure**

Run `npm --prefix apps/web test -- src/auth/session.test.ts src/api/client.test.ts`. Expected: no session provider and development Token branch remains.

- [ ] **Step 3: Implement memory-only session provider**

Fetch `/api/auth/access-token` same-origin, retain only access token/expiry/employee in provider memory, refresh one minute early and build login return path from current route. Do not add LocalStorage, SessionStorage, URL token or query persistence.

- [ ] **Step 4: Make API retry deterministic**

Remove `VITE_REIMBURSEMENT_DEV_TOKEN` and its types. Obtain Authorization from TokenProvider; allocate each mutable request’s idempotency key once and reuse it for the one post-refresh retry. GET may refresh/retry once without the header.

- [ ] **Step 5: Wire bootstrapping and Vite proxies**

Wrap the app in `AuthSessionProvider`, defer protected UI until first session resolution and redirect unauthenticated users. Proxy `/api/auth` to Auth BFF while retaining `/api/v1` proxy to Go.

- [ ] **Step 6: Verify and commit**

Run `npm --prefix apps/web test && npm --prefix apps/web run build`; expect PASS and no production development-token branch. Commit with `feat: authenticate React reimbursement calls with Feishu sessions`.

### Task 7: Private-Routing Deployment Guardrails

**Files:**
- Modify: `infra/nginx/reimbursement-routes.conf`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Create: `docs/operations/unified-feishu-identity.md`
- Create: `tests/contract/reimbursement-routing.test.ts`

**Interfaces:**
- Public routes are `/`, `/api/auth/`, `/api/v1/`; `/internal/` is rejected before proxying.

- [ ] **Step 1: Write failing routing contract test**

Read Nginx route configuration and assert Auth BFF and Go routes target correct services, `/internal/` has a non-proxy deny response, and no secret literal appears in config/runbook.

- [ ] **Step 2: Verify failure**

Run `npm test -- tests/contract/reimbursement-routing.test.ts`. Expected: current migration fragment lacks unified auth rules and private-route deny.

- [ ] **Step 3: Implement routing and configuration protections**

Route the three public prefixes under one host; explicitly reject `/internal/`. Keep Go port 8080 Docker `expose` only and pass Provisioning Key via the existing secret file.

- [ ] **Step 4: Write an operator runbook**

Document separate random secrets, role lists, restart order, login/token-refresh/Agent-first-contact checks, coordinated JWT key rotation and rollback without exposing internal routes.

- [ ] **Step 5: Verify and commit**

Run `npm test -- tests/contract/reimbursement-routing.test.ts && docker compose --profile migration config --quiet`; expect PASS. Commit with `docs: secure unified identity deployment routes`.

### Task 8: Cross-Boundary Regression and Final Verification

**Files:**
- Create: `tests/integration/unified-feishu-identity.test.ts`
- Create: `apps/web/src/auth/session.e2e.test.tsx`
- Modify: `README.md`
- Modify: `docs/migration/react-go-cutover-runbook.md`

**Interfaces:**
- Consumes Tasks 1–7 and proves OAuth and Agent first-contact use one employee ID before reaching Go claim APIs.

- [ ] **Step 1: Write failing cross-boundary tests**

Use fake Feishu identity/provisioning HTTP to assert first OAuth and Agent contact share one employee, idempotent ensure only projects once, ordinary employees cannot publish/resolve, inactive employees cannot write, and React reload recovers only via `/api/auth/access-token`.

- [ ] **Step 2: Verify failure**

Run `npm test -- tests/integration/unified-feishu-identity.test.ts && npm --prefix apps/web test -- src/auth/session.e2e.test.tsx`. Expected: seams are not yet wired.

- [ ] **Step 3: Apply only integration seam fixes**

Fix incompatibilities exposed by the stated contracts. Do not expand scope to enterprise SSO, role UI, persistent browser tokens or old-data migration.

- [ ] **Step 4: Update developer and cutover documentation**

Document startup profiles, variable names, local personal-Feishu validation and the requirement for a fixed HTTPS domain before multi-user staging.

- [ ] **Step 5: Run the full verification matrix**

Run `npm test`; `npm --prefix apps/web test`; `npm --prefix apps/web run build`; `npm --prefix services/agent test`; `docker run --rm -v "${PWD}:/src" -w /src/services/reimbursement-api golang:1.27.1-alpine go test ./...`; `docker compose --profile migration config --quiet`; and `git diff --check`. Expected: all exit 0 and no test logs secrets or open IDs.

- [ ] **Step 6: Commit final verification work**

Commit with `test: verify unified Feishu identity flow`.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 establish signed claims and authorization; Tasks 3–5 synchronize OAuth/Agent identity into Go; Task 6 implements browser session behavior; Task 7 limits deployment exposure; Task 8 proves cross-boundary behavior.
- **Step scan:** Every task has a failing test, one bounded implementation action, a verification command and a scoped commit.
- **Type consistency:** `employeeId` is the same value in `ResolvedEmployeeIdentity`, JWT `sub`, Go `Actor.ID`, Agent tool context and `reimbursement.employees.id`; roles are exactly `EMPLOYEE`, `FINANCE_REVIEWER`, `ADMIN`.
- **Review focus coverage:** hostile redirects (Task 4), duplicate role lists (Task 1), malformed/cross-channel tokens (Task 2), internal key/routing isolation (Tasks 3/7), idempotent refresh retry (Task 6).
- **Proportion:** Eight independently testable tasks cover the stated services without creating a new identity provider or broadening scope.
