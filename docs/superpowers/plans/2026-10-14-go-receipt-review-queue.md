# Go 票据人工复核案件队列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auditable Go-owned OCR receipt review queue that turns abnormal receipts into claimable, resolvable finance work items.

**Architecture:** Extend the existing `reimbursement.review_cases` schema and replace the current standalone receipt review marker with transactional receipt-and-case transitions. The Go API exposes role-protected list, detail, claim, and resolve endpoints; the React review route consumes those endpoints as a queue and detail workspace. Existing worker retry and receipt extraction paths become explicit triggers, while employee-facing claim views stay free of internal review reasons.

**Tech Stack:** Go 1.27, `net/http`, pgx/PostgreSQL 16, NATS JetStream, OpenAPI 3.1, React 19, TanStack Query, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-14-go-receipt-review-queue-design.md`

## Global Constraints

- Scope is OCR receipt review only; do not implement policy-source review, role administration, approval flows, or batch operations.
- Use `0.7` as the only low-confidence review threshold because it matches Go submission validation.
- Security-isolated `MALWARE_DETECTED` receipts remain outside the finance review queue.
- A receipt has at most one open or claimed review case; identical issue codes are recorded once.
- Employee APIs never expose review reason codes, reviewer identities, resolutions, or audit records.
- All write authorization remains in Go API role and ownership checks; React only reflects API capabilities.
- Keep `REIMBURSEMENT_ALLOW_DUPLICATE_*_FOR_TESTING` behavior local-test-only and unchanged.
- Do not create commits unless the user explicitly authorizes one.

## Review Focus

- A duplicate JetStream delivery after a case was already created must return success without a second case or duplicate issue row; cover in Task 3.
- A low-confidence OCR result that otherwise has all fields must become a review case and remain submission-blocking; cover in Task 3.
- Two reviewers claiming the same version must yield exactly one successful claim and one conflict; cover in Task 2 and Task 4.
- A correction that still duplicates a submitted invoice must leave the case claimed and the receipt non-extracted; cover in Task 3.
- A regular employee attempting any `/api/v1/admin/reviews` operation must receive `403` without receiving case metadata; cover in Task 4.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `services/reimbursement-api/db/migrations/000012_receipt_review_queue.sql` | Extend review-case persistence, deduplicate legacy issues, backfill pending receipt cases and enforce partial uniqueness. |
| `services/reimbursement-api/internal/application/review_cases.go` | Domain views, commands, state/role guards and repository port for receipt review cases. |
| `services/reimbursement-api/internal/application/review_cases_test.go` | Pure application-service lifecycle, authority and conflict tests. |
| `services/reimbursement-api/internal/application/receipt_service.go` | Create review cases for duplicate/low-confidence extraction outcomes through a receipt-review transition port. |
| `services/reimbursement-api/internal/application/extract_receipt_test.go` | Extraction-trigger behavior tests. |
| `services/reimbursement-api/internal/store/receipt_repository.go` | Transactional receipt status, issue, review case, audit and outbox writes. |
| `services/reimbursement-api/internal/store/policy_review_repository.go` | Replace resolve-only adapter with repository queries, conditional claim and action persistence. |
| `services/reimbursement-api/internal/store/*_test.go` | PostgreSQL integration tests for uniqueness, backfill-safe transitions and concurrency guards. |
| `services/reimbursement-api/internal/workers/jetstream_receipt.go` | Convert retry exhaustion into the same idempotent review transition and acknowledge business-blocking errors. |
| `services/reimbursement-api/internal/workers/receipt_extraction_test.go` | Exhaustion and duplicate-delivery worker tests. |
| `services/reimbursement-api/internal/transport/http/admin_handler.go` | List/detail/claim/resolve handlers and role responses. |
| `services/reimbursement-api/internal/transport/http/router.go` | Register the new review routes. |
| `services/reimbursement-api/internal/transport/http/claims_handler_test.go` | HTTP authorization, payload, version-conflict and privacy tests. |
| `api/openapi/reimbursement-v1.yaml` | Publish the review queue contract. |
| `apps/web/src/api/generated/reimbursement.ts` | Hand-maintained generated contract types for review views and commands. |
| `apps/web/src/api/client.ts` | Typed review queue client methods. |
| `apps/web/src/api/client.test.ts` | Request method, body and auth-boundary client tests. |
| `apps/web/src/routes/review-center-page.tsx` | Queue list, detail and action UI. |
| `apps/web/src/routes/review-center-page.test.tsx` | Loading, empty, claim, resolve and error interaction tests. |
| `apps/web/src/styles.css` | Queue/detail layout and responsive state styling using existing tokens. |
| `README.md` | Replace the Go review-queue TODO with usage and verification guidance. |

## Tasks

### Task 1: Add receipt review queue schema and legacy-safe constraints

**Files:**
- Create: `services/reimbursement-api/db/migrations/000012_receipt_review_queue.sql`
- Test: `services/reimbursement-api/internal/store/postgres_review_case_repository_test.go`

**Interfaces:**
- Produces: `review_cases.receipt_id`, `reason_code`, `claimed_at`, `version`, `updated_at`; a partial unique index for active receipt cases; unique `(receipt_id, code)` issue rows.
- Consumed by: Tasks 2–5.

- [ ] **Step 1: Write failing PostgreSQL integration tests for legacy backfill, duplicate issue suppression, and one active case per receipt**

Create tests that seed a `REVIEW_REQUIRED` receipt with duplicate issue rows, apply the migration to the disposable Go test database, and assert one normalized issue plus one `OPEN` case using the earliest reason. Assert a second active case insert for the same receipt fails, while a new case after `RESOLVED` is allowed.

- [ ] **Step 2: Run the focused store test to verify it fails before migration exists**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/store -run TestReceiptReviewQueueMigration`

Expected: FAIL because the migration/schema columns and indexes do not exist.

- [ ] **Step 3: Implement migration `000012_receipt_review_queue.sql`**

Add nullable `receipt_id` only for backwards-compatible non-receipt rows, non-null reason/version defaults for receipt cases, `claimed_at`, `updated_at`, issue deduplication before adding the unique constraint, active-case partial uniqueness, and deterministic legacy backfill IDs. Grant the existing API database role only the needed access.

- [ ] **Step 4: Run the focused migration/store test to verify it passes**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Create a local commit only if explicitly authorized**

Suggested message: `feat(go): add receipt review queue schema`

### Task 2: Define review case lifecycle and repository operations

**Files:**
- Modify: `services/reimbursement-api/internal/application/review_cases.go`
- Modify: `services/reimbursement-api/internal/application/review_cases_test.go`
- Modify: `services/reimbursement-api/internal/store/policy_review_repository.go`
- Create: `services/reimbursement-api/internal/store/postgres_review_case_repository_test.go`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces: `ListReceiptCases`, `GetReceiptCase`, `ClaimReceiptCase`, and `ResolveReceiptCase` application methods; typed `ReviewCaseView`, `ClaimReviewCaseCommand`, and `ResolveReceiptCaseCommand`.
- Consumed by: Tasks 3–5.

- [ ] **Step 1: Write failing application tests for role restrictions, claim races, claimant-only resolution and administrator takeover**

Add tests where `EMPLOYEE` is denied; one of two same-version claims succeeds; a non-claimant cannot resolve; and `ADMIN` can resolve a claimed case. Include an expected-version mismatch assertion.

- [ ] **Step 2: Run the application review-case tests to verify they fail**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/application -run TestReviewCase`

Expected: FAIL because the list, claim, action and versioned lifecycle interfaces do not exist.

- [ ] **Step 3: Implement application lifecycle types and PostgreSQL repository methods**

Model `OPEN`, `CLAIMED`, `RESOLVED`, and `CLOSED`; make `Claim` a conditional `OPEN + version` update; make resolution conditional on current version and claimant/admin authorization. Query receipt case details with only fields safe for finance roles. Write `review_case_audits` for claim and each resolution action in the same transaction.

- [ ] **Step 4: Add failing store tests for conditional updates and audit rows, then implement them**

Assert concurrent conditional claim behavior, version increment, and one audit row per successful action using a real PostgreSQL test database. Implement only the repository SQL needed for those tests.

- [ ] **Step 5: Run application and store tests to verify they pass**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/application ./internal/store -run 'TestReviewCase|TestPostgresReviewCase'`

Expected: PASS.

- [ ] **Step 6: Create a local commit only if explicitly authorized**

Suggested message: `feat(go): add review case lifecycle`

### Task 3: Make abnormal receipt transitions create or reuse cases atomically

**Files:**
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/application/extract_receipt_test.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service_test_helpers_test.go`
- Modify: `services/reimbursement-api/internal/store/receipt_repository.go`
- Modify: `services/reimbursement-api/internal/store/postgres_receipt_repository_test.go`

**Interfaces:**
- Consumes: Task 2 review lifecycle port and Task 1 constraints.
- Produces: an idempotent receipt-review transition used by synchronous upload/extraction and Task 4's worker exhaustion path.
- Consumed by: Tasks 4–6.

- [ ] **Step 1: Write failing extraction tests for duplicate content, submitted-invoice duplicate, low confidence and correction retry behavior**

Add one test per reason: content duplicate enters review; submitted invoice persists safe OCR candidate fields and enters review; confidence `0.69` enters review while `0.70` does not; a corrected duplicate invoice remains claimed/non-extracted. Assert identical retry calls leave exactly one case and one issue code.

- [ ] **Step 2: Run focused extraction tests to verify they fail**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/application -run 'TestExtractReceipt|TestFinalizeReceiptUpload'`

Expected: FAIL because the current marker only changes receipt status and does not create cases or apply the low-confidence threshold.

- [ ] **Step 3: Implement the atomic `TransitionReceiptToReview` store operation and route receipt paths through it**

Within one transaction, lock the receipt, set `REVIEW_REQUIRED`, insert the unique issue code, insert-or-return the active case, append receipt/review audits, and publish the receipt review Outbox event. For OCR outcomes, persist safe candidate fields before creating the case so finance can review them; do not persist raw OCR text.

- [ ] **Step 4: Implement versioned resolution effects for receipt cases**

Make `CONFIRM` and `CORRECT_FIELDS` transition a valid receipt to `EXTRACTED`; recheck duplicate submitted invoice numbers during correction. Make `REQUEST_REUPLOAD` and `CLOSE_INVALID` set `QUARANTINED`. Roll back both case and receipt changes on validation/conflict failure.

- [ ] **Step 5: Run extraction and PostgreSQL receipt tests to verify they pass**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/application ./internal/store -run 'TestExtractReceipt|TestFinalizeReceiptUpload|TestPostgresReceipt'`

Expected: PASS.

- [ ] **Step 6: Create a local commit only if explicitly authorized**

Suggested message: `feat(go): create review cases for abnormal receipts`

### Task 4: Connect JetStream exhaustion and publish the finance review API

**Files:**
- Modify: `services/reimbursement-api/internal/workers/jetstream_receipt.go`
- Modify: `services/reimbursement-api/internal/workers/receipt_extraction_test.go`
- Modify: `services/reimbursement-api/cmd/worker/main.go`
- Modify: `services/reimbursement-api/internal/transport/http/admin_handler.go`
- Modify: `services/reimbursement-api/internal/transport/http/router.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `api/openapi/reimbursement-v1.yaml`

**Interfaces:**
- Consumes: Task 2 lifecycle service and Task 3 receipt transition.
- Produces: authenticated HTTP review queue contract for Task 5.

- [ ] **Step 1: Write failing worker tests for OCR retry exhaustion and business-blocking errors**

Assert max delivery creates/reuses exactly one `OCR_RETRY_EXHAUSTED` case and acknowledges the message. Assert `DUPLICATE_SUBMITTED_INVOICE` and `LOW_OCR_CONFIDENCE` are acknowledged after creating a case rather than redelivered.

- [ ] **Step 2: Run worker tests to verify they fail**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/workers -run 'TestProcessReceiptMessage|TestReceiptExtraction'`

Expected: FAIL because the worker only marks a receipt and treats business-blocking extraction errors as retryable.

- [ ] **Step 3: Implement worker delegation to the receipt review transition**

Inject the new review-capable service/repository into `cmd/worker/main.go`; acknowledge stale/deleted receipts and completed business-review transitions, while preserving retries for transient failures only.

- [ ] **Step 4: Write failing HTTP tests for list/detail/claim/resolve, 403 privacy and 409 version conflicts**

Use signed actor contexts to assert finance/admin access, employee denial without payload, claim race conflict, and action validation. Cover `GET /api/v1/admin/reviews`, `GET /{id}`, `POST /{id}/claim`, and versioned `POST /{id}/resolve`.

- [ ] **Step 5: Implement handlers, route registration and OpenAPI contract**

Parse bounded pagination and action-specific payloads; authorize through the existing admin handler; map unavailable/version conflicts to `409` and ordinary employees to `403`. Update OpenAPI schemas and paths before React types consume them.

- [ ] **Step 6: Run worker and HTTP tests to verify they pass**

Run: `docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./internal/workers ./internal/transport/http`

Expected: PASS.

- [ ] **Step 7: Create a local commit only if explicitly authorized**

Suggested message: `feat(go): expose receipt review queue api`

### Task 5: Replace the React manual resolution form with a review workspace

**Files:**
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/routes/review-center-page.tsx`
- Create: `apps/web/src/routes/review-center-page.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 4 OpenAPI response/request schemas.
- Produces: finance-facing `/admin/reviews` queue UI.
- Consumed by: Task 6 acceptance and documentation.

- [ ] **Step 1: Write failing client tests for list, detail, claim and versioned resolve calls**

Assert correct URLs, request methods, body fields and error propagation for every Task 4 endpoint.

- [ ] **Step 2: Run the focused client tests to verify they fail**

Run: `npm --prefix apps/web test -- src/api/client.test.ts`

Expected: FAIL because queue methods and generated request/response types do not exist.

- [ ] **Step 3: Implement typed review queue client methods and generated contract types**

Expose `listReviews`, `getReview`, `claimReview`, and `resolveReview`. Keep request authentication delegated to the existing client token bridge; do not add employee or role data to browser requests.

- [ ] **Step 4: Write failing route tests for loading, empty, claim, action submission, 403 and 409 states**

Render the page with mocked API client behavior. Assert an open case can be selected and claimed, a claimed case shows finance actions, and conflict/permission feedback is visible without stale optimistic state.

- [ ] **Step 5: Implement `ReviewCenterPage` and scoped styles**

Use TanStack Query for list/detail refreshes. Build a responsive list-and-detail layout from existing workbench styles; disable actions while requests run; only render finance-safe data returned by the API.

- [ ] **Step 6: Run focused React tests and production build to verify they pass**

Run: `npm --prefix apps/web test -- src/api/client.test.ts src/routes/review-center-page.test.tsx; npm --prefix apps/web run build`

Expected: PASS and Vite production build completes.

- [ ] **Step 7: Create a local commit only if explicitly authorized**

Suggested message: `feat(web): add receipt review queue workspace`

### Task 6: Complete regression verification and operational documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/superpowers/specs/2026-10-14-go-receipt-review-queue-design.md` only if verification exposes a required design correction

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: operator verification instructions and an updated project capability statement.

- [ ] **Step 1: Write the failing or missing regression tests identified during end-to-end review**

Add only tests needed to cover an untested specification acceptance criterion, especially employee-safe claim output after `REQUEST_REUPLOAD` and migration backfill behavior.

- [ ] **Step 2: Run each new focused test to verify its pre-fix behavior**

Run the owning Go or React command from Tasks 1–5.

Expected: a meaningful failure before its minimal implementation, or PASS only if the case is already covered by an existing named test.

- [ ] **Step 3: Update README and operations guidance**

Replace the Go review queue TODO with exact local verification steps: migrate the Go database, create a deliberately low-confidence/duplicate test receipt, claim it as a finance reviewer, resolve it, and verify the employee workbench only receives safe status. State that the duplicate testing switches are development-only.

- [ ] **Step 4: Run complete regression verification**

Run:

```powershell
docker compose --profile migration config --quiet
docker run --rm -v "${PWD}/services/reimbursement-api:/src" -w /src golang:1.27.1 go test ./...
npm test
npm --prefix apps/web test
npm --prefix apps/web run build
git diff --check
```

Expected: all commands succeed; document any environment-only limitation such as unavailable Docker daemon rather than masking it.

- [ ] **Step 5: Create a local commit only if explicitly authorized**

Suggested message: `docs: document receipt review queue verification`

## Plan Self-Review

- **Spec coverage:** Tasks 1–4 implement all lifecycle, triggers, transactional persistence, role, privacy, event and API requirements; Task 5 implements the React workspace; Task 6 covers documentation and end-to-end verification. Policy sync, role administration, malware handling and batch actions remain explicitly out of scope.
- **Step scan:** Each task begins with a failing behavior test, then a narrow implementation and a focused pass command before broader verification.
- **Type consistency:** Task 2 defines the review case views/commands consumed by Tasks 3–4; Task 4 publishes the OpenAPI contract consumed by Task 5; Task 5 adds no independent browser authorization model.
- **Review focus:** Each listed failure mode is explicitly assigned to Task 2, 3 or 4 tests.
- **Proportion:** The plan records interfaces and test cases, not production function bodies; implementation choices remain inside the named components.

## 当前交付备注（2026-10-23）

本轮已交付并本地验证 OCR 票据复核队列、业务化案件展示及原票预览闭环。README、运行指引、OpenAPI、Go API 与 React 复核中心已保持一致；Go 全量测试、Web 测试与构建、严格项目审计、差异空白检查以及受影响容器重建均已完成。原计划中保留的后续验证项不扩大本次功能边界。
