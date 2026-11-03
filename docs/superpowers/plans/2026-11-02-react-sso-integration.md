# React SSO Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the migration React workbench and Go API to the local Feishu SSO with immediate cross-project logout.

**Architecture:** The Next.js Auth BFF performs OIDC code + PKCE, stores an opaque React session, and issues short Web JWTs carrying Hydra `sid`. SSO persists verified Feishu identity for scoped ID Token claims and offers a service-authenticated sid status endpoint. Go checks sid revocation on each Web API request; the agent channel and existing Next.js UI remain unchanged.

**Tech Stack:** Go 1.27, Hydra 2.3, PostgreSQL, Next.js 15, React 19, Prisma 7, openid-client 6, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-local-sso-integration-design.md`

## Global Constraints

- SSO source worktree: `D:\AI\temp-projects\feishu-sso-react-integration`; reimbursement source worktree: `D:\AI\ai-reimbursement-agent\.worktrees\react-sso-integration`.
- Preserve existing Next.js direct Feishu login, development login, bot and agent token handling.
- Do not delete or migrate existing employee/claim data, print secrets, or commit `.env` / `.env.local`.
- The React migration profile uses edge port `8088`. Keep SSO's verified ports `9000`, `4444`, `4445`, `5433`.
- All protected React BFF and Go Web requests fail closed when SSO status cannot be checked.

## Review Focus

- A remembered Hydra login must still resolve the member identity when consent runs without a new Feishu callback.
- An ID Token from another client, missing `sid`, or missing `feishu_open_id` must not provision an employee.
- Old or forged Web JWTs without a valid sid must not reach Go Web handlers; agent channel must remain unaffected.
- Logout must invalidate API access even if back-channel notification is delayed or fails.
- Local port remapping and container-to-host routing must work with both Compose projects running.

---

### Task 1: SSO scoped Feishu identity claim

**Files:** `internal/session/identity_store.go`, `internal/session/identity_store_test.go`, `internal/server/server.go`, `internal/server/server_test.go`, `cmd/sso/main.go` in the SSO worktree.

**Interfaces:** `MemberStore.Upsert(ctx, subject, feishu.Identity) error` and `MemberStore.BySubject(ctx, subject) (feishu.Identity, error)`; `server.Config.Members` receives this store. Consent accepts `feishu_identity` scope and sets `session.id_token.feishu_open_id` only when requested; it rejects missing or wrong-tenant mapped identity.

- [ ] Add failing tests for persisted mapping, Feishu callback write-before-accept, remembered consent lookup, missing mapping, and no claim for clients without scope.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement the store and consent claim with the smallest changes.
- [ ] Run focused and full SSO Go tests, `go vet`, and an actual Hydra ID Token check.
- [ ] Commit the SSO change.

### Task 2: SSO service-authenticated sid status

**Files:** `internal/server/logout.go`, `internal/server/logout_test.go`, `cmd/sso/main.go`, `.env.example`, `README.md` in the SSO worktree.

**Interfaces:** `POST /internal/session-status` accepts JSON `{ "sid": "..." }` only with `X-SSO-Service-Key`; responses are 204 active, 401 revoked, 503 storage unavailable. Key comparison is constant-time. Existing bearer ID Token `/session-status` remains unchanged.

- [ ] Add failing tests for active, revoked, missing/wrong key, malformed sid, and storage failure.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement the endpoint and local environment validation.
- [ ] Run full SSO tests and `go vet`.
- [ ] Commit the SSO change.

### Task 3: React Auth BFF OIDC session

**Files:** `package.json`, `package-lock.json`, `prisma/schema.prisma`, new Prisma migration, `src/server/sso-oidc.ts`, `src/server/sso-web-session.ts`, `app/api/auth/sso/{login,callback,logout,backchannel-logout}/route.ts`, tests in `tests/unit/server/` and `tests/integration/api/` in the reimbursement worktree.

**Interfaces:** OIDC client uses issuer `http://localhost:4444/`, client `reimbursement-web`, exact edge callback, code + PKCE and nonce. Opaque `reimbursement_sso_session` Cookie indexes a server-side session with employee ID, `sid`, encrypted ID Token and expiry. Callback calls `ensureFeishuIdentity` with verified `feishu_open_id`. `getActiveSsoWebSession(request)` verifies central `/session-status` using the ID Token; invalid/revoked returns unauthenticated and unavailable returns service unavailable.

- [ ] Add failing tests for state/nonce/code validation, audience/issuer/sid/identity claim rejection, successful employee provisioning, session cookie properties, back-channel signature/claims, and delayed-notification revocation.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement OIDC routes, session persistence and migration; register a dedicated Hydra client with `openid profile feishu_identity`.
- [ ] Run focused tests, root type check and lint.
- [ ] Commit the BFF change.

### Task 4: Web JWT binding and Go revocation check

**Files:** `src/server/reimbursement-auth.ts`, `app/api/auth/access-token/route.ts`, relevant TypeScript tests; `services/reimbursement-api/internal/transport/http/auth_middleware.go`, `services/reimbursement-api/cmd/api/main.go`, Go tests in reimbursement worktree.

**Interfaces:** `createReimbursementJwt` adds required `sid` for React Web tokens. `/api/auth/access-token` uses only the active SSO session in the migration profile. Go `WebBearerResolver` requires `sid` and invokes an `SSOSessionChecker` using the service key; 401/503 both deny protected Web access. `channel=agent` verification is unchanged.

- [ ] Add failing TypeScript and Go tests for valid sid, missing/forged sid, central revocation/outage, and unaffected agent token.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement BFF issuance and Go check.
- [ ] Run focused suites, root type check, Go tests and vet.
- [ ] Commit the change.

### Task 5: React flow, local ports and documentation

**Files:** `apps/web/src/auth/session.tsx`, `apps/web/src/app.tsx`, adjacent React tests, `docker-compose.yml`, `.env.example`, `docs/operations/unified-feishu-identity.md`, SSO registration script and README.

**Interfaces:** React login points to `/api/auth/sso/login`, logout navigates through `/api/auth/sso/logout`, `/logged-out` does not auto-login. Compose host ports are configurable with existing defaults; SSO integration uses `15433` PostgreSQL and `19000` MinIO. Hydra back-channel URI reaches edge `8088` from its container.

- [ ] Add failing React tests for SSO navigation and logged-out state.
- [ ] Run tests and verify expected failures.
- [ ] Implement UI routing, Compose configuration, client registration and local runbook.
- [ ] Run React tests/build, root tests/type check/lint/build, Go tests, Compose config check and `git diff --check`.
- [ ] Commit changes in both repositories.

### Task 6: Integrated local acceptance

**Files:** Verification scripts or tests only where they catch a real regression; no new production surface unless a failure requires it.

- [ ] Start both Compose projects with distinct host ports, apply Prisma/Go migrations, and verify SSO/BFF/Go connectivity without exposing secrets.
- [ ] Verify scoped Hydra identity claim, React login, employee creation, and both member identities.
- [ ] Verify logout from React and demos A/B denies React BFF and Go Web JWT, including a token issued before logout; verify the agent path remains valid.
- [ ] Re-run final suites and review both diffs for correctness and secret leakage.
- [ ] Report verified behavior and any remaining manual Feishu/browser steps. Push only to feature branches if authorized by the existing session.
