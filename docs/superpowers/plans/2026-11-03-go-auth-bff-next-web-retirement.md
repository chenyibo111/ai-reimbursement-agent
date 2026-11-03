# Go Auth BFF and Next Web Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move React authentication from Next.js to the existing Go API, then stop the Next.js Web service while retaining Node Workers.

**Architecture:** Go handles the existing `/api/auth/*` browser contract, using Hydra for OIDC and the existing SSO sid-status service for immediate revocation. PostgreSQL stores Go-owned opaque sessions while Go preserves each SSO open ID's existing Prisma employee ID and reimbursement projection. Nginx routes auth and business API traffic to Go; React and the SSO client URLs remain unchanged.

**Tech Stack:** Go 1.27, PostgreSQL 16, Hydra 2.3, OIDC authorization code + PKCE, React 19, Docker Compose, Go tests and Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-go-auth-bff-next-web-retirement-design.md`

## Global Constraints

- Work on `feat/react-sso-integration` in `D:\AI\ai-reimbursement-agent\.worktrees\react-sso-integration`.
- Preserve React paths `/api/auth/sso/login`, `/api/auth/sso/callback`, `/api/auth/sso/logout`, `/api/auth/sso/backchannel-logout`, `/api/auth/access-token`, and the existing access-token JSON fields.
- Preserve `reimbursement-web` Hydra client ID, canonical issuer `http://localhost:4444/`, and edge port `8088` in local verification.
- Preserve Web JWT `aud=reimbursement-api`, `channel=web`, `sid`, and 15-minute lifetime; leave Agent channel behavior unchanged.
- SSO and bot Feishu applications have different open IDs; do not auto-link their identities or change Node Worker behavior.
- Keep Node Workers in Compose. The shared image may still run `next build`; this phase stops the Next.js runtime service only.
- Do not delete employees, claims, existing Prisma sessions, or SSO data. Old browser cookies may require re-login.
- Do not expose `/internal/*` at the edge or commit `.env` / `.env.local` secrets.

## Review Focus

- A validly shaped ID Token signed by an untrusted key must not create an employee or a session.
- A callback with wrong state, nonce, code verifier, issuer, audience, missing sid, or missing Feishu open ID must fail without provisioning.
- Two concurrent first logins for one open ID must resolve to one employee ID; an existing public/Go ID mismatch must fail closed.
- SSO outage must deny `/api/auth/access-token` and existing Web JWT access; Agent channel must keep its prior behavior.
- Logout started before Hydra revocation must remain retryable, while an old Web JWT must fail immediately once the sid is revoked even if the notification is delayed.

---

### Task 1: Go-owned session storage and SSO employee identity

**Files:**
- Create: `services/reimbursement-api/db/migrations/000016_go_sso_auth.sql`
- Create: `services/reimbursement-api/internal/store/web_auth_repository.go`
- Test: `services/reimbursement-api/internal/store/web_auth_repository_test.go`

**Interfaces:** `WebAuthRepository.ResolveEmployee(ctx, openID, displayName, role) (EmployeeIdentity, error)` returns `{ID, DisplayName, Role, IsActive}`; `PutSession(ctx, SessionRecord)`, `FindSession(ctx, idHash)`, `DeleteSessionsBySID(ctx, sid)` access `reimbursement.sso_web_sessions`. `SessionRecord` has `{IDHash, EmployeeID, SID, EncryptedIDToken, ExpiresAt}`. ResolveEmployee uses one transaction across `public."Employee"` and `reimbursement.employees` for the same SSO open ID, returning an existing ID and rejecting a cross-table ID mismatch. Store tests create a minimal `public."Employee"` fixture because the Go-only test schema does not apply Prisma migrations; the product migration grants public-table rights only when that table already exists.

- [ ] Write failing database tests for an existing Next BFF employee ID, first login, repeat login, concurrent first login, mismatched IDs, and session CRUD by sid.
- [ ] Run `go test ./internal/store -run TestWebAuth -count=1` against a migrated isolated PostgreSQL database and verify the expected failures.
- [ ] Add migration and repository; grant only required public employee rights to the Go app role and preserve existing rows.
- [ ] Re-run `go test ./internal/store -run TestWebAuth -count=1` and `go test ./...`; verify all pass.
- [ ] Commit the independently tested persistence change.

### Task 2: OIDC client and session security

**Files:**
- Modify: `services/reimbursement-api/go.mod`, `services/reimbursement-api/go.sum`
- Create: `services/reimbursement-api/internal/auth/oidc.go`
- Create: `services/reimbursement-api/internal/auth/session.go`
- Test: `services/reimbursement-api/internal/auth/oidc_test.go`, `services/reimbursement-api/internal/auth/session_test.go`

**Interfaces:** `OIDCClient.Begin(ctx, returnTo) (Authorization, error)` and `Exchange(ctx, code, pending) (VerifiedIdentity, error)` expose `{Subject, SID, FeishuOpenID, DisplayName, ExpiresAt, IDToken}` only after signature and claim validation. `EndSession(ctx, idToken) (url.URL, error)` preserves the registered post-logout URL. `SessionService.Create`, `Active`, and `DeleteBySID` use Task 1's repository, hash an opaque 32-byte cookie, encrypt the ID Token using `SESSION_SECRET`, and check the SSO sid on every `Active` call. Use `golang.org/x/oauth2` PKCE and `coreos/go-oidc/v3` ID Token verification; Task 4 verifies back-channel JWTs with `go-jose/v4` and the provider JWKS.

- [ ] Write failing tests for PKCE/state/nonce and exact callback URL, forged signature with trusted `kid`, wrong issuer/audience, expired/missing claims, cookie tampering, session expiry, sid revocation, and SSO outage.
- [ ] Run `go test ./internal/auth -run 'TestOIDC|TestSession' -count=1` and verify expected failures.
- [ ] Implement OIDC client, canonical issuer with container dial override, and encrypted session service without exposing ID Tokens to the browser.
- [ ] Run `go test ./internal/auth -count=1`, `go test ./...`, and `go vet ./...`; verify all pass.
- [ ] Commit the security primitives.

### Task 3: Go browser login, callback, and access token

**Files:**
- Create: `services/reimbursement-api/internal/transport/http/auth_bff.go`
- Modify: `services/reimbursement-api/internal/transport/http/router.go`, `services/reimbursement-api/cmd/api/main.go`
- Test: `services/reimbursement-api/internal/transport/http/auth_bff_test.go`

**Interfaces:** `AuthBFF` receives Task 2 OIDC/session services and Task 1 identity repository. The Go router serves `/api/auth/*` before its business Bearer middleware. `GET /api/auth/access-token` returns `{accessToken,expiresAt,employee:{id,displayName,role}}`; the Go JWT signer emits the same HS256 claims currently emitted by `createReimbursementJwt`.

- [ ] Write failing handler tests for login cookies/redirect, callback rejection and employee creation, exact access-token JSON/JWT claims, missing/stale cookie, revoked sid, SSO outage, role allowlists, and unsafe `returnTo`.
- [ ] Run `go test ./internal/transport/http -run TestAuthBFF -count=1` and verify expected failures.
- [ ] Implement routes and configuration; keep pending OIDC cookies short-lived, HttpOnly, SameSite=Lax, and scoped to `/api/auth/sso`.
- [ ] Run `go test ./internal/transport/http -run TestAuthBFF -count=1`, `go test ./...`, and `go vet ./...`; verify all pass.
- [ ] Commit the Go login and token contract.

### Task 4: RP logout and signed back-channel notification

**Files:**
- Create: `services/reimbursement-api/internal/auth/logout_token.go`
- Modify: `services/reimbursement-api/internal/transport/http/auth_bff.go`, `services/reimbursement-api/internal/transport/http/router.go`
- Test: `services/reimbursement-api/internal/auth/logout_token_test.go`, `services/reimbursement-api/internal/transport/http/auth_bff_test.go`

**Interfaces:** `GET /api/auth/sso/logout` starts Hydra logout without deleting retryable local state. `POST /api/auth/sso/backchannel-logout` verifies signature, issuer, exact audience, sid, jti, iat, logout event, and absence of nonce, then calls `DeleteBySID`. Invalid requests cannot remove sessions.

- [ ] Write failing tests for successful logout redirect, Hydra outage, valid notification, wrong signature/audience, stale token rejection, idempotent repeat notification, malformed body, and delayed notification after sid revocation.
- [ ] Run `go test ./internal/auth ./internal/transport/http -run 'TestLogout|TestAuthBFF' -count=1` and verify expected failures.
- [ ] Implement logout URL and back-channel verification with bounded body size and JWKS retrieval.
- [ ] Run `go test ./internal/auth ./internal/transport/http -run 'TestLogout|TestAuthBFF' -count=1`, `go test ./...`, and `go vet ./...`; verify all pass.
- [ ] Commit global logout handling.

### Task 5: Switch the edge and stop the Next Web service

**Files:**
- Modify: `infra/nginx/reimbursement-routes.conf`, `docker-compose.yml`, `.env.example`, `docs/operations/local-sso-react.md`
- Test: `tests/contract/reimbursement-routing.test.ts`, `tests/integration/docker-worker-compose.test.ts`, adjacent Compose tests

**Interfaces:** `/api/auth/*` and `/api/v1/*` route to `reimbursement-api:8080`; `/` routes to `reimbursement-web:8080`; `/internal/*` stays 404. `web` has profile `legacy-web` and is absent from ordinary startup and the edge's dependencies. Node Workers remain available.

- [ ] Write failing routing/Compose tests for the new upstream and absence of default Next Web; assert Worker services remain configured.
- [ ] Run `node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/contract/reimbursement-routing.test.ts tests/integration/docker-worker-compose.test.ts` and verify expected failures.
- [ ] Change edge and Compose, document migrations, configuration, cookie re-login, and rollback with explicit `legacy-web` profile.
- [ ] Re-run those two Vitest files, `docker compose --env-file .env.local -p reimbursement-sso --profile migration config --quiet`, React `npm test` and `npm run build` in `apps/web`, and `git diff --check`; verify all pass.
- [ ] Commit the cutover configuration and runbook.

### Task 6: Integrated acceptance and final review

**Files:** Verification artifacts only where they catch a real regression.

- [ ] Apply Go migration to the isolated local database, rebuild Go/edge, and verify no Next `web` container is required by the migration profile.
- [ ] Exercise Hydra authorization, employee provisioning, access-token, Go claims API, React logout, demo A/B logout, old-JWT revocation, and back-channel cleanup with a local synthetic member; remove synthetic records afterward.
- [ ] Verify both real test-enterprise members in separate browser sessions if available; otherwise report this manual acceptance step precisely.
- [ ] Run full Go tests/vet, React tests/build, root Vitest/typecheck/lint, Compose config, and branch diff/secret review. Confirm the Node Worker runtime and Agent channel are unaffected.
- [ ] Report results and keep all commits on `feat/react-sso-integration`; push only if already authorized for this branch.
