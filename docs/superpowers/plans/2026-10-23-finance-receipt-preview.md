# 财务复核原票预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a finance reviewer to securely open the original receipt from a review case.

**Architecture:** A Go application service joins a receipt review case to the trusted receipt record and asks MinIO for a verified, short-lived GET URL. The existing protected admin route returns that URL; the React review screen opens it in a new tab after the authenticated request succeeds.

**Tech Stack:** Go, MinIO Go SDK, net/http, OpenAPI, React, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-finance-receipt-preview-design.md`

## Global Constraints

- Only `FINANCE_REVIEWER` and `ADMIN` may call the preview endpoint.
- The response must not contain an object key, storage credential, or internal MinIO hostname.
- URLs are GET-only and expire after 10 minutes.
- Missing objects and signing errors return the safe `RECEIPT_PREVIEW_UNAVAILABLE` error.

## Review Focus

- An employee token must receive 403 before any receipt lookup or presigned URL is created.
- A review ID for a non-receipt or missing case must return the existing 404 case error.
- A missing MinIO object must not produce a signed URL that fails only after opening a browser tab.
- The UI must close its temporary tab and show an inline error when the preview request fails.
- The UI must not display the presigned URL in page text or state beyond navigation.

### Task 1: Protected preview service and endpoint

**Files:**
- Create: `services/reimbursement-api/internal/application/receipt_preview.go`
- Modify: `services/reimbursement-api/internal/infrastructure/minio_store.go`
- Modify: `services/reimbursement-api/internal/transport/http/admin_handler.go`
- Modify: `services/reimbursement-api/internal/transport/http/router.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`
- Test: `services/reimbursement-api/internal/application/receipt_preview_test.go`
- Test: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`

**Interfaces:**
- Produces `ReceiptPreviewService.Get(ctx, role, reviewID) (ReceiptPreview, error)` and `GET /api/v1/admin/reviews/{reviewId}/receipt-preview`.

- [x] Write failing service and handler tests for a finance role, employee rejection, and unavailable object.
- [x] Run the focused Go tests and verify they fail because preview types/routes do not exist.
- [x] Implement a receipt lookup plus verified MinIO GET presigning service and map safe errors in the admin handler.
- [x] Run focused tests and verify they pass.

### Task 2: API contract and finance UI action

**Files:**
- Modify: `api/openapi/reimbursement-v1.yaml`
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/routes/review-center-page.tsx`
- Test: `apps/web/src/api/client.test.ts`
- Test: `apps/web/src/routes/review-center-page.test.tsx`

**Interfaces:**
- Consumes `GET /api/v1/admin/reviews/{reviewId}/receipt-preview -> { url, expiresAt }`.

- [x] Write failing client and page tests that expect a button to request the URL and navigate a newly opened tab.
- [x] Run targeted frontend tests and verify they fail because the client action and button are absent.
- [x] Add the typed API client, OpenAPI shape, and accessible “查看原票” action with safe error feedback.
- [x] Run targeted frontend tests and verify they pass.

### Task 3: End-to-end verification

**Files:**
- Modify: `docs/superpowers/plans/2026-10-23-finance-receipt-preview.md`

- [x] Run Go, frontend, build, diff, and project audit checks.
- [x] Rebuild the affected `reimbursement-api` and `reimbursement-web` containers.
- [x] Record completed verification commands in this plan.

## Verification record

- `docker run --rm -v "${PWD}:/workspace" -w /workspace/services/reimbursement-api golang:1.27.1-alpine go test ./...` — passed.
- `npm --prefix apps/web test` — 9 files / 34 tests passed.
- `npm --prefix apps/web run build` — passed.
- `python .../audit_project.py . --mode strict --no-write` — 0 findings.
- `git diff --check` — no whitespace errors.
- `docker compose --profile migration up -d --build reimbursement-api reimbursement-web` — both containers recreated and API logged `reimbursement API listening on :8080`.

## 交付备注

- **2026-10-23：已完成本计划。** 本地验证覆盖权限拒绝、原票缺失的安全失败，以及成功预览时的新标签页导航；本计划关联的服务和前端容器已完成重建。
