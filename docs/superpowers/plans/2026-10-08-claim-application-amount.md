# Claim Application Amount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let employees save a claim-level requested reimbursement amount, fixed CNY currency, and remark, while retaining OCR invoice totals as independent, auditable suggestions.

**Architecture:** Add forward-only PostgreSQL migration `000011`, then propagate the fields through the Go domain, repository, HTTP/OpenAPI contract and React facade. A dedicated server-side OCR suggestion refresher updates the requested amount only while its source is `OCR_SUGGESTED`; manual edits set `MANUAL` and cannot be overwritten. Submission validation and immutable snapshots consume the same claim projection.

**Tech Stack:** PostgreSQL 16, Go 1.27, pgx, NATS/JetStream worker, OpenAPI, React 19, TypeScript, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-claim-application-amount-design.md`

## Global Constraints

- Store money as non-negative integer cents; reject fractional cents, negative values and `int64` overflow.
- First release accepts only `CNY`; no FX, multi-currency aggregation or receipt-currency work.
- Keep OCR receipt totals separate from `requested_amount_cent`; never overwrite `MANUAL` data.
- Only `DRAFT` claims are mutable; preserve optimistic `version` behavior.
- Limit `remark` to 1,000 Unicode characters; exclude it from OCR, knowledge, bot messages and logs.
- Preserve existing uncommitted upload/OAuth/MinIO changes; stage only task files.

## Review Focus

- `0`, `0.01` and a large valid value produce exact cents; `1.234`, `-0.01`, exponent notation and overflow return `INVALID_REQUEST` (Task 2).
- A second OCR result updates `OCR_SUGGESTED`, but cannot change a `MANUAL` amount (Task 3).
- Clearing manual value immediately restores current OCR sum, or null where no recognized total exists (Tasks 2–3).
- A late OCR refresh cannot overwrite a newer manual update; UI preserves input on version conflict (Tasks 3–4).
- Missing requested amount blocks confirmation and final submit; the submission snapshot contains all four claim fields (Task 2).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `services/reimbursement-api/db/migrations/000011_claim_application_fields.sql` | Schema, defaults, constraints and grants. |
| `internal/domain/claim.go` | Claim fields, sources, validation and patch rules. |
| `internal/application/claim_service.go` | Explicit employee patch command. |
| `internal/application/refresh_claim_ocr_suggestion.go` | OCR-only suggestion refresh port. |
| `internal/application/receipt_service.go` | Calls the refresher after successful extraction. |
| `internal/store/claim_repository.go` | Claim projection/update plus transactional suggestion refresh. |
| `internal/application/submission_service.go` and `internal/store/submission_repository.go` | Required amount validation and snapshot projection. |
| `internal/transport/http/claims_handler.go` and `api/openapi/reimbursement-v1.yaml` | Strict request/response contract. |
| `apps/web/src/features/claims/claim-application-form.tsx` | Accessible form and local input parsing. |
| `apps/web/src/routes/claim-workbench-page.tsx` | Workbench placement and OCR refresh UI. |

### Task 1: Persist and project claim application fields

**Files:**
- Create: `services/reimbursement-api/db/migrations/000011_claim_application_fields.sql`
- Modify: `services/reimbursement-api/internal/domain/claim.go`
- Modify: `services/reimbursement-api/internal/application/claim_service.go`
- Modify: `services/reimbursement-api/internal/store/claim_repository.go`
- Test: `services/reimbursement-api/internal/domain/claim_test.go`
- Test: `services/reimbursement-api/internal/application/claim_service_test.go`
- Test: `services/reimbursement-api/internal/store/postgres_claim_repository_test.go`

**Interfaces:**
- Consumes: `domain.Claim`, `domain.ClaimPatch`, `application.ClaimRepository`.
- Produces: `domain.RequestedAmountSource`, `Claim.RequestedAmountCent *int64`, `Claim.Currency string`, `Claim.RequestedAmountSource RequestedAmountSource`, `Claim.Remark string`, and equivalent patch fields with an explicit restore flag.

- [ ] **Step 1: Write failing domain/application tests**

Assert a new draft starts `CNY` + `OCR_SUGGESTED` + nil amount; manual `10155` becomes `MANUAL`; non-CNY and a 1,001-character remark return `domain.ErrInvalidClaim`; submitted and stale claims remain rejected.

- [ ] **Step 2: Run focused tests to verify failure**

Run from `services/reimbursement-api`: `go test ./internal/domain ./internal/application -run 'Test.*(RequestedAmount|Currency|Remark)' -count=1`.

Expected: FAIL because these fields and rules do not exist.

- [ ] **Step 3: Add migration `000011_claim_application_fields.sql`**

Add nullable `requested_amount_cent BIGINT CHECK (requested_amount_cent >= 0)`, `currency CHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY')`, `requested_amount_source TEXT NOT NULL DEFAULT 'OCR_SUGGESTED' CHECK (...)`, and nullable `remark TEXT CHECK (char_length(remark) <= 1000)` to `reimbursement.claims`. Existing rows retain null amount and safe defaults.

- [ ] **Step 4: Extend domain and PostgreSQL projections**

Define `OCR_SUGGESTED`/`MANUAL`, extend clone and `Claim.Patch`, and select/scan/create/update the new columns in `claim_repository.go`. Keep `ClaimRepository.Update` audit/outbox behavior atomic.

- [ ] **Step 5: Add persistence test and verify pass**

Create, update and reload a manual 10,155-cent claim with remark; assert another employee cannot access it. Run: `go test ./internal/domain ./internal/application ./internal/store -run 'Test.*(RequestedAmount|Currency|Remark|ClaimRepository)' -count=1`.

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add services/reimbursement-api/db/migrations/000011_claim_application_fields.sql services/reimbursement-api/internal/domain/claim.go services/reimbursement-api/internal/domain/claim_test.go services/reimbursement-api/internal/application/claim_service.go services/reimbursement-api/internal/application/claim_service_test.go services/reimbursement-api/internal/store/claim_repository.go services/reimbursement-api/internal/store/postgres_claim_repository_test.go
git commit -m "feat: persist claim application amount fields"
```

### Task 2: Expose guarded updates and submission facts

**Files:**
- Modify: `services/reimbursement-api/internal/application/claim_service.go`
- Modify: `services/reimbursement-api/internal/application/submission_service.go`
- Modify: `services/reimbursement-api/internal/application/submission_test.go`
- Modify: `services/reimbursement-api/internal/store/submission_repository.go`
- Modify: `services/reimbursement-api/internal/store/postgres_submission_repository_test.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `api/openapi/reimbursement-v1.yaml`
- Test: `tests/contract/openapi-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 fields and `PATCH /api/v1/claims/{claimId}` version contract.
- Produces: request keys `requestedAmountCent`, `currency`, `remark`, `useOcrSuggestedAmount`; response fields `requestedAmountCent`, `currency`, `requestedAmountSource`, `remark`; validation code `REQUESTED_AMOUNT_REQUIRED`.

- [ ] **Step 1: Write failing transport and submission tests**

Cover integer-cent input, non-CNY, unknown-key rejection, explicit restore, stale version, missing amount blocking, and snapshot fields.

- [ ] **Step 2: Run focused tests to verify failure**

Run from `services/reimbursement-api`: `go test ./internal/application ./internal/transport/http -run 'Test.*(RequestedAmount|ClaimPatch|Submission)' -count=1`.

Expected: FAIL because API and validation are absent.

- [ ] **Step 3: Extend patch transport and claim response**

Accept only exact keys. Require `requestedAmountCent` to be a JSON integer, `currency` to equal `CNY`, `remark` to be string/null, and `useOcrSuggestedAmount: true` as the only manual-clear operation. Reject decimals, exponent JSON values, conflicting manual amount plus restore, and unknown keys as `INVALID_REQUEST`.

- [ ] **Step 4: Enforce required amount and snapshot projection**

Add `REQUESTED_AMOUNT_REQUIRED` to `validateSubmissionInput`; extend `loadOwnedClaim` and JSON snapshot payload. Preserve both confirmation-time and transaction-time validation.

- [ ] **Step 5: Update OpenAPI and contract test**

Describe nullable cent amount, fixed CNY currency, source enum, nullable remark and PATCH constraints. Keep schemas aligned with handler response fields.

- [ ] **Step 6: Verify and commit Task 2**

Run from repository root: `npm test -- tests/contract/openapi-contract.test.ts`; run Go focused command from Step 2. Then:

```powershell
git add services/reimbursement-api/internal/application/claim_service.go services/reimbursement-api/internal/application/submission_service.go services/reimbursement-api/internal/application/submission_test.go services/reimbursement-api/internal/store/submission_repository.go services/reimbursement-api/internal/store/postgres_submission_repository_test.go services/reimbursement-api/internal/transport/http/claims_handler.go services/reimbursement-api/internal/transport/http/claims_handler_test.go api/openapi/reimbursement-v1.yaml tests/contract/openapi-contract.test.ts
git commit -m "feat: expose claim application amount API"
```

Expected: tests PASS.

### Task 3: Refresh OCR suggestion without overriding employee input

**Files:**
- Create: `services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion.go`
- Create: `services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion_test.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/application/extract_receipt_test.go`
- Modify: `services/reimbursement-api/internal/store/claim_repository.go`
- Modify: `services/reimbursement-api/internal/store/postgres_claim_repository_test.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`
- Modify: `services/reimbursement-api/cmd/worker/main.go`

**Interfaces:**
- Consumes: Task 1 source enum, `EXTRACTED` receipts, `total_amount_cent`.
- Produces: `ClaimOCRSuggestionRefresher.RefreshOCRSuggestion(ctx context.Context, claimID string, actorID string) error`, called after `ReceiptRepository.MarkExtracted` succeeds.

- [ ] **Step 1: Write failing OCR-suggestion lifecycle tests**

Prove first 10,155-cent receipt suggests 10,155; a 2,000-cent second receipt suggests 12,155; manual 9,999 remains unchanged; restore uses current sum; no recognized amount leaves nil.

- [ ] **Step 2: Run focused tests to verify failure**

Run from `services/reimbursement-api`: `go test ./internal/application -run 'Test.*OCR.*Suggestion' -count=1`.

Expected: FAIL because no refresher exists.

- [ ] **Step 3: Implement one application port and atomic store method**

Compute only extracted receipts with non-null amounts. In a PostgreSQL transaction, update only claims with source `OCR_SUGGESTED`, write audit/outbox on an actual change, and reread/stop if a newer manual update wins. Do not let handlers or workers write the field directly.

- [ ] **Step 4: Invoke after successful OCR persistence and wire both binaries**

Make `ReceiptService` call the optional refresher after `MarkExtracted`; propagate real failure for JetStream retry. Inject it in both API and worker `main.go`; skip review/quarantine/error paths.

- [ ] **Step 5: Add store concurrency coverage, verify and commit Task 3**

Assert an old OCR refresh cannot overwrite a newer manual update and that an OCR suggestion writes audit/outbox. Run: `go test ./internal/application ./internal/store ./internal/workers -run 'Test.*(OCR.*Suggestion|ExtractReceipt|ClaimRepository)' -count=1`.

```powershell
git add services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion.go services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion_test.go services/reimbursement-api/internal/application/receipt_service.go services/reimbursement-api/internal/application/extract_receipt_test.go services/reimbursement-api/internal/store/claim_repository.go services/reimbursement-api/internal/store/postgres_claim_repository_test.go services/reimbursement-api/cmd/api/main.go services/reimbursement-api/cmd/worker/main.go
git commit -m "feat: default claim amount from OCR totals"
```

Expected: tests PASS.

### Task 4: Add the React claim information form

**Files:**
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/api/client.ts`
- Test: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/features/claims/use-claim.ts`
- Create: `apps/web/src/features/claims/claim-application-form.tsx`
- Test: `apps/web/src/features/claims/claim-application-form.test.tsx`
- Modify: `apps/web/src/routes/claim-workbench-page.tsx`
- Test: `apps/web/src/features/claims/claim-workbench.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 2 claim response and PATCH API, existing `claimKeys.detail(claimId)` invalidation.
- Produces: `ClaimApplicationForm({ claim, recognizedAmountCent, onSaved })` and `useUpdateClaim(claimId)`; visible application amount, fixed CNY, remark, OCR sum and restore action.

- [ ] **Step 1: Write failing client and component tests**

Assert `101.55` maps to 10,155; third decimal gives inline error without request; save updates version; mismatch reveals restore; restore sends only `useOcrSuggestedAmount: true`; server error preserves typed amount and remark.

- [ ] **Step 2: Run focused React tests to verify failure**

Run: `npm --prefix apps/web test -- claim-application-form client`.

Expected: FAIL because types, mutation and form do not exist.

- [ ] **Step 3: Add typed client mutation and cache behavior**

Extend the checked-in Claim facade. Add `updateClaim(claimId, patch)` with idempotency key, then `useUpdateClaim` invalidating detail, list and validation after success but preserving local form state after error.

- [ ] **Step 4: Implement accessible `ClaimApplicationForm`**

Use `<form noValidate>`, controlled decimal text input with `inputMode="decimal"`, string parsing without floating point, read-only CNY, controlled textarea and inline live feedback. Disable while saving/submitted; surface OCR sum and non-blocking difference copy through associated descriptions.

- [ ] **Step 5: Integrate the form and responsive styles**

Place it between receipt archive and submission check. While receipt polling is active, refetch claim projection on the same cadence so OCR suggestions appear without reload. Use existing card/tokens; a two-column form becomes one column below 760px.

- [ ] **Step 6: Verify and commit Task 4**

Run: `npm --prefix apps/web test -- claim-application-form claim-workbench client`; then:

```powershell
git add apps/web/src/api/generated/reimbursement.ts apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/web/src/features/claims/use-claim.ts apps/web/src/features/claims/claim-application-form.tsx apps/web/src/features/claims/claim-application-form.test.tsx apps/web/src/routes/claim-workbench-page.tsx apps/web/src/features/claims/claim-workbench.test.tsx apps/web/src/styles.css
git commit -m "feat: add claim amount and remark form"
```

Expected: tests PASS.

### Task 5: Document rollout and complete verification

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Test: `tests/contract/openapi-contract.test.ts`

**Interfaces:**
- Consumes: migrations `000010`/`000011`, Task 2 contract and Task 4 UI.
- Produces: migration order, safe SQL smoke check and employee acceptance steps.

- [ ] **Step 1: Document migration and acceptance**

Cover backup, forward-only `000011` execution, API/worker/web/edge restart, safe read-only SQL checks, OCR suggestion, manual override, restore, remark boundary, required amount validation and snapshot facts.

- [ ] **Step 2: Run complete automated verification**

Run from `services/reimbursement-api`: `go test ./... -count=1`.

Run from repository root: `npm --prefix apps/web test; npm --prefix apps/web run build; npm test; docker compose --profile migration config --quiet; git diff --check`.

Expected: all commands exit 0.

- [ ] **Step 3: Apply local migration and restart affected services**

Pipe the checked-in SQL to `docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement`, then run `docker compose --profile migration up -d --build reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge`.

Expected: migration succeeds and changed containers are Up.

- [ ] **Step 4: Perform authenticated browser acceptance without submitting a real claim**

Use one existing draft: save `101.55` / CNY / a short remark; verify persistence, restore OCR suggestion and inspect updated claim response. Avoid final submission.

- [ ] **Step 5: Commit Task 5**

```powershell
git add README.md docs/operations.md
git commit -m "docs: document claim application amount rollout"
```
