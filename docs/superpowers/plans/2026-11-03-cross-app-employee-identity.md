# Cross-App Employee Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web SSO and Feishu bot resolve the same tenant member to one reimbursement employee ID without exposing another employee's records.

**Architecture:** The Feishu SSO service and bot each resolve a trusted `(tenant_key,user_id)` with their own Feishu app credentials. A Go identity resolver owns a transactional app-identity mapping table and returns the canonical internal employee ID. Existing duplicate rows are reconciled through an explicit dry-run and approved migration, never by name.

**Tech Stack:** Go, Ory Hydra/OIDC, PostgreSQL, Prisma, TypeScript, Feishu OpenAPI.

**Spec:** `docs/superpowers/specs/2026-11-03-cross-app-employee-identity-design.md`

**Progress (2026-11-03):** Tasks 1–3 are implemented and covered by focused tests. Task 4 is wired but the real Feishu/Web cross-entry acceptance is pending. Task 5 has a reviewed-mapping dry-run/apply command and isolated transaction tests; no mapping has been applied to user data. Task 6 requires the two Feishu apps to have the member-ID permission, the SSO client registration and migrations to be deployed, and a live two-member walkthrough. React Agent chat remains out of scope.

## Global Constraints

- React does not gain an Agent chat entry.
- Do not use or compare cross-application `open_id` values as a user key.
- Do not merge employees across tenants or by name, email, or phone.
- Preserve existing employee IDs and historical data until a reviewed reconciliation is run.
- Do not log tokens, app secrets, or raw user profiles.

## Review Focus

- Missing Feishu `user_id` or permission denial must fail closed without creating a second business identity (Tasks 1, 3).
- Signed OIDC token from a different issuer/audience or wrong tenant must be rejected (Task 2).
- Concurrent Web login and bot message for the same member must return one employee ID (Task 3).
- A verified member whose two old employee rows both own data must receive a conflict report rather than a silent merge (Task 5).
- Disabled employees and role assignments must not be reset by either entrance (Tasks 3, 4).

---

### Task 1: Resolve Feishu member ID in both applications

**Files:** `D:/AI/feishu-sso/internal/feishu/client.go`, its test; `src/infrastructure/feishu/feishu-bot-client.ts`, its test.

**Interfaces:** SSO `Identity` gains `UserID`; bot client gains `getMemberIdentity(openId): Promise<{openId,userId,tenantKey}>`. Each implementation uses only its own app credentials.

- [x] Add failing tests for a valid member, a missing ID, a different tenant, and Feishu permission failure.
- [x] Implement contact lookup with the required field permission and strict response validation.
- [x] Run the two focused suites and update permissions documentation.

### Task 2: Sign and validate canonical identity in OIDC

**Files:** `D:/AI/feishu-sso/internal/server/server.go`, its test; `services/reimbursement-api/internal/auth/oidc.go`, its test.

**Interfaces:** ID Token claims contain `feishu_open_id`, `feishu_tenant_key`, `feishu_user_id`, `feishu_app_id`, and name. Go `VerifiedIdentity` returns all four identifiers after signature, audience, nonce, and tenant validation.

- [x] Add failing tests for claims propagated through Hydra consent, missing custom claims, forged token, and wrong tenant.
- [x] Carry verified Feishu identity in Hydra login context and consent session ID Token claims; verify on Go callback.
- [x] Run SSO and Go auth suites.

### Task 3: Introduce canonical employee resolver

**Files:** `services/reimbursement-api/db/migrations/000017_employee_identity_links.sql`, `services/reimbursement-api/internal/store/employee_identity_links.go`, its test, `services/reimbursement-api/internal/transport/http/router.go`, internal identity handler tests.

**Interfaces:** Resolve `(tenantKey,userID,appID,openID,displayName)` to `{employeeID,role,isActive}` in one database transaction. An internal service-key endpoint exposes the operation to the bot. Legacy `open_id` columns stay available during transition.

- [x] Add failing integration tests for cross-app same member, cross-tenant isolation, binding conflicts, concurrent first use, and inactive employees.
- [x] Add schema constraints and transaction-safe resolver; prevent silent merge when historical rows disagree.
- [x] Expose authenticated internal endpoint and run Go store/transport tests.

### Task 4: Switch Web and bot entrance to canonical resolver

**Files:** `services/reimbursement-api/internal/transport/http/auth_bff.go`, its test; `src/server/employee-identity.ts`, `src/worker/feishu-bot.ts`, and focused tests; `.env.example` and `docs/operations/local-sso-react.md`.

**Interfaces:** Web callback passes signed identity claims to Go resolver. Bot validates sender via Feishu and calls the same resolver. Existing tool context receives returned `employeeID` unchanged.

- [ ] Add failing tests for Web-created draft visible via bot identity and bot-created draft visible in Web, plus disabled employee and service-key rejection.
- [x] Wire both entry points, keeping Feishu replies on the bot app's API.
- [ ] Run Node, Go and routing suites; document deployment order and permissions.

### Task 5: Reconcile existing duplicate employees safely

**Files:** `scripts/reconcile-employee-identities.ts` or Go equivalent, dedicated tests, and operations runbook.

**Interfaces:** `dry-run` reports verified old/new employee IDs and reference counts; `apply` requires an explicit mapping file and confirmation of a database backup. No match by display name.

- [ ] Add failing tests for two employees with claims/conversations, unknown external identity, conflicting unique references, and rollback on error.
- [x] Implement read-only report and transactional apply across public and reimbursement references, invalidating old Web sessions.
- [ ] Run focused tests and dry-run against local data; record counts. Do not run `apply` before reviewing the actual report.

### Task 6: End-to-end verification

**Files:** focused end-to-end tests and `docs/operations/local-sso-react.md`.

- [ ] Exercise two distinct Feishu applications with one tenant member and one different member.
- [ ] Verify Web→bot and bot→Web claim ownership, role, inactive-user, logout, and failed-permission behavior.
- [ ] Run repository suites, migrations on a disposable database, and inspect the final diff.
