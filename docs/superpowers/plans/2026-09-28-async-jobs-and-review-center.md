# 异步任务与人工复核中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OCR 提取与政策同步建立可恢复的 PostgreSQL 异步任务队列及具备角色隔离的人工复核中心。

**Architecture:** Prisma 持久化 `AsyncJob` 与 `ReviewCase`，由常驻 Worker 通过条件更新领取并执行既有 OCR/同步用例。Web 请求只入队；受控管理 API 和 `/admin/reviews` 提供领取、解决和重试，所有权限从 `Employee.role` 与服务端数据库读取。

**Tech Stack:** Next.js 15、TypeScript、Prisma 7、PostgreSQL、Vitest、Docker Compose、既有 PaddleOCR/MinIO/飞书知识库。

**Spec:** `docs/superpowers/specs/2026-09-28-async-jobs-and-review-center-design.md`

## Global Constraints

- 不新增 Redis、BullMQ 或外部队列；PostgreSQL 是第一期唯一任务存储与协调器。
- 不在任务参数、浏览器响应或日志中保存对象键、附件二进制、飞书 token、完整 OCR 原文或模型提示词。
- 权限一律从签名会话的 actor ID 和数据库 `Employee.role` 得出，不能信任浏览器或飞书传入的角色。
- OCR 与政策同步必须复用 `extractReceipt`、`syncPolicySource`，不得复制或绕过既有业务校验。
- 员工只能读取自己的安全状态；内部失败码、复核备注和其他员工数据仅供已授权复核人员读取。
- 每项状态变迁、角色变更和字段修正必须有审计记录；任何解决操作必须遵守草稿版本冲突语义。

## Review Focus

- 同一任务被两台 Worker 同时领取：只有一台能取得 lease，另一台不执行外部 OCR/Embedding 调用（Task 2）。
- Worker 在写入费用项后崩溃再重试：不会因同一 `receiptId` 创建第二条费用项（Task 3）。
- 两位复核员同时领取一张票据：仅一个条件更新成功，非领取人不能解决（Task 5）。
- 已被删除的草稿、票据或政策来源：任务安全关闭，不泄露内部对象信息（Task 2、Task 4）。
- 员工直接访问管理员接口或伪造 role：返回 403 且不写入任务/复核状态（Task 5）。

---

## 文件与职责映射

| 文件 | 职责 |
|---|---|
| `prisma/schema.prisma`、新 migration | 角色、任务、复核表及索引。 |
| `src/domain/async-job.ts` | 不依赖 Prisma 的任务状态转换、退避与安全错误分类。 |
| `src/infrastructure/prisma/async-job-repository.ts` | 原子入队、领取、lease 恢复、完成、重试、复核查询。 |
| `src/application/process-async-job.ts` | 根据任务种类加载权威对象并调用既有业务用例。 |
| `src/worker/job-worker.ts` | 常驻轮询、优雅停机、日志边界。 |
| `src/application/review-case.ts` | 领取、解决、重试和角色授权的用例。 |
| `app/api/admin/reviews/**`、`app/api/admin/employees/**` | 受控管理 API。 |
| `src/ui/review-center.tsx`、`app/(authenticated)/admin/reviews/page.tsx` | 复核中心界面。 |

### Task 1: 角色、任务与复核数据模型

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_async_jobs_and_reviews/migration.sql`
- Create: `src/domain/async-job.ts`
- Modify: `src/server/authorization.ts`
- Create: `src/worker/role-bootstrap.ts`
- Test: `tests/unit/domain/async-job.test.ts`
- Test: `tests/integration/async-job-repository.test.ts`

**Interfaces:**
- Produces `EmployeeRole`, `AsyncJobKind`, `AsyncJobStatus`, `ReviewCaseKind`, `ReviewCaseStatus` Prisma enums and `AsyncJob`/`ReviewCase` relations.
- Produces `nextRetryAt(attemptCount, now): Date`, `isRetryableJobFailure(code): boolean`, `canReviewOcr(role): boolean`, `canManagePolicyReview(role): boolean`.

- [ ] **Step 1: Write failing domain and repository tests**

Test default employee role, 1/5/30 minute retry schedule, exactly one active job for a receipt/source, and role predicates.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/unit/domain/async-job.test.ts tests/integration/async-job-repository.test.ts`

Expected: FAIL because async-job domain/repository and Prisma entities do not exist.

- [ ] **Step 3: Implement schema, migration, role helpers and bootstrap command**

`role-bootstrap` accepts a server-local employee ID and promotes only that record to `ADMIN`; it is documented as the one-time deployment operation. Add partial unique indexes for unfinished jobs and an index supporting status/available time polling.

- [ ] **Step 4: Regenerate Prisma client and rerun tests**

Run: `npx prisma generate --config prisma7.config.ts && npm test -- --run tests/unit/domain/async-job.test.ts tests/integration/async-job-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma src/domain/async-job.ts src/server/authorization.ts src/worker/role-bootstrap.ts tests/unit/domain/async-job.test.ts tests/integration/async-job-repository.test.ts
git commit -m "feat: add async job and review domain"
```

### Task 2: PostgreSQL queue repository与Worker领取机制

**Files:**
- Create: `src/infrastructure/prisma/async-job-repository.ts`
- Create: `src/application/run-async-job-worker.ts`
- Create: `src/worker/job-worker.ts`
- Modify: `package.json`
- Test: `tests/integration/async-job-repository.test.ts`
- Test: `tests/unit/application/run-async-job-worker.test.ts`

**Interfaces:**
- Consumes Task 1 enums and retry helpers.
- Produces `enqueueJob(input)`, `claimNextJob(now, leaseMs)`, `recoverExpiredLeases(now)`, `markSucceeded`, `markRetryWait`, `markReviewRequired`, `closeMissingTarget`.
- Produces `runAsyncJobWorkerOnce(deps): Promise<boolean>`.

- [ ] **Step 1: Write failing tests**

Test atomic duplicate enqueue, concurrent claim with one winner, expired lease recovery, max-attempt transition to `REVIEW_REQUIRED`, and missing target close.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/integration/async-job-repository.test.ts tests/unit/application/run-async-job-worker.test.ts`

Expected: FAIL because the queue repository and worker runner are absent.

- [ ] **Step 3: Implement queue persistence and worker runner**

Use an `updateMany` conditional state transition for claiming; never select then update without a status predicate. The runner starts by recovering expired leases and records only safe job metadata.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/integration/async-job-repository.test.ts tests/unit/application/run-async-job-worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/prisma/async-job-repository.ts src/application/run-async-job-worker.ts src/worker/job-worker.ts package.json tests/integration/async-job-repository.test.ts tests/unit/application/run-async-job-worker.test.ts
git commit -m "feat: add durable async job worker"
```

### Task 3: 异步 OCR 与安全人工复核入队

**Files:**
- Modify: `src/application/upload-receipt.ts`
- Modify: `src/application/extract-receipt.ts`
- Create: `src/application/process-async-job.ts`
- Modify: `app/api/claims/[claimId]/receipts/route.ts`
- Modify: `app/api/conversations/private/attachments/route.ts`
- Modify: `src/worker/feishu-bot.ts`
- Test: `tests/unit/application/process-async-job.test.ts`
- Test: `tests/integration/api/receipt-upload.test.ts`
- Test: `tests/integration/async-ocr-flow.test.ts`

**Interfaces:**
- Consumes Task 2 `enqueueJob` and worker runner.
- Produces `processReceiptExtractionJob(jobId, deps)` and one `ReviewCase` for low-confidence, duplicate, or exhausted extraction.

- [ ] **Step 1: Write failing tests**

Assert upload returns without calling OCR, enqueues exactly one extraction job, worker creates at most one expense item for a receipt across retries, and duplicate/low-confidence outputs create one open OCR review.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/unit/application/process-async-job.test.ts tests/integration/api/receipt-upload.test.ts tests/integration/async-ocr-flow.test.ts`

Expected: FAIL because upload still performs synchronous extraction.

- [ ] **Step 3: Implement asynchronous OCR orchestration**

Keep preflight and object storage synchronous. After receipt persistence enqueue `RECEIPT_EXTRACTION`; only the Worker invokes `extractReceipt`. Make `extractReceipt` idempotent for an already-linked `ExpenseItem` and map provider failures to safe retry/review categories.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/unit/application/process-async-job.test.ts tests/integration/api/receipt-upload.test.ts tests/integration/async-ocr-flow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/upload-receipt.ts src/application/extract-receipt.ts src/application/process-async-job.ts app/api/claims/[claimId]/receipts/route.ts app/api/conversations/private/attachments/route.ts src/worker/feishu-bot.ts tests/unit/application/process-async-job.test.ts tests/integration/api/receipt-upload.test.ts tests/integration/async-ocr-flow.test.ts
git commit -m "feat: process receipt extraction asynchronously"
```

### Task 4: 异步政策同步

**Files:**
- Modify: `app/api/admin/policy-sources/[sourceId]/sync/route.ts`
- Modify: `src/application/process-async-job.ts`
- Modify: `src/worker/policy-sync.ts`
- Test: `tests/integration/api/policy-source-routes.test.ts`
- Test: `tests/integration/async-policy-sync-flow.test.ts`

**Interfaces:**
- Consumes Task 2 queue and Task 3 shared `processAsyncJob` dispatch.
- Produces non-blocking policy sync creation and `POLICY_SYNC` review cases after retry exhaustion.

- [ ] **Step 1: Write failing tests**

Assert admin sync responds with a queued task, duplicate requests reuse it, worker invokes `syncPolicySource`, and exhausted embedding/document failures create an admin-only policy review without changing active snapshots.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/integration/api/policy-source-routes.test.ts tests/integration/async-policy-sync-flow.test.ts`

Expected: FAIL because sync executes in the route.

- [ ] **Step 3: Enqueue policy sync and remove direct route execution**

Keep `policy-sync.ts` as a narrow compatibility CLI that creates and drains one job; the normal worker owns all retries and status transitions.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/integration/api/policy-source-routes.test.ts tests/integration/async-policy-sync-flow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/policy-sources/[sourceId]/sync/route.ts src/application/process-async-job.ts src/worker/policy-sync.ts tests/integration/api/policy-source-routes.test.ts tests/integration/async-policy-sync-flow.test.ts
git commit -m "feat: queue policy source synchronization"
```

### Task 5: 复核与角色授权用例及管理 API

**Files:**
- Create: `src/application/review-case.ts`
- Create: `src/infrastructure/prisma/review-case-repository.ts`
- Create: `app/api/admin/reviews/route.ts`
- Create: `app/api/admin/reviews/[reviewId]/claim/route.ts`
- Create: `app/api/admin/reviews/[reviewId]/resolve/route.ts`
- Create: `app/api/admin/reviews/[reviewId]/retry/route.ts`
- Create: `app/api/admin/employees/[employeeId]/role/route.ts`
- Test: `tests/integration/api/review-routes.test.ts`
- Test: `tests/unit/application/review-case.test.ts`

**Interfaces:**
- Consumes Task 1 role predicates and Task 2 review state records.
- Produces `claimReviewCase`, `resolveReviewCase`, `retryReviewJob`, `setEmployeeRole` with expected-version/claim ownership guards.

- [ ] **Step 1: Write failing tests**

Cover 403 for employees, successful OCR claim by reviewer, concurrent claim single winner, non-owner resolve rejection, admin-only policy retry, field correction audit, and refusal to remove the final admin.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/unit/application/review-case.test.ts tests/integration/api/review-routes.test.ts`

Expected: FAIL because review use cases and routes are absent.

- [ ] **Step 3: Implement review/role authorization**

Use server-loaded roles on every request. `CORRECT_FIELDS` calls an explicit receipt-field correction use case with claim `expectedVersion`; `REQUEST_INFORMATION` creates a Clarification; `CLOSE` retains reason and history.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/unit/application/review-case.test.ts tests/integration/api/review-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/review-case.ts src/infrastructure/prisma/review-case-repository.ts app/api/admin/reviews app/api/admin/employees tests/unit/application/review-case.test.ts tests/integration/api/review-routes.test.ts
git commit -m "feat: add authorized review case operations"
```

### Task 6: 复核中心与员工状态界面

**Files:**
- Create: `app/(authenticated)/admin/reviews/page.tsx`
- Create: `src/ui/review-center.tsx`
- Modify: `app/(authenticated)/layout.tsx`
- Modify: `src/ui/claim-workbench.tsx`
- Modify: `src/ui/claim-types.ts`
- Modify: `app/globals.css`
- Modify: `UX-CONTRACT.md`
- Test: `tests/unit/ui/review-center.test.ts`
- Test: `tests/unit/ui/claim-types.test.ts`

**Interfaces:**
- Consumes Task 5 management APIs and review DTOs.
- Produces accessible review list/detail controls and employee-safe receipt task labels.

- [ ] **Step 1: Read `frontend-design` and `frontend-design-premium` skills, then write failing UI tests**

Test empty/loading/error states, reviewer-only action availability, safe employee status copy, and exact confirmation/retry controls without internal error text leaking into employee views.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/unit/ui/review-center.test.ts tests/unit/ui/claim-types.test.ts`

Expected: FAIL because the review UI and task labels are absent.

- [ ] **Step 3: Implement the shared review center and state presentation**

Follow `DESIGN.md`/`UX-CONTRACT.md`; use semantic table/buttons, stable busy states, keyboard-accessible details, and responsive employee-safe receipt cards. Add a navigation item only when the server session resolves to reviewer/admin.

- [ ] **Step 4: Run UI tests and production build**

Run: `npm test -- --run tests/unit/ui/review-center.test.ts tests/unit/ui/claim-types.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(authenticated)/admin/reviews src/ui/review-center.tsx src/ui/claim-workbench.tsx src/ui/claim-types.ts app/globals.css UX-CONTRACT.md tests/unit/ui/review-center.test.ts tests/unit/ui/claim-types.test.ts
git commit -m "feat: add review center workspace"
```

### Task 7: Docker、运行文档与端到端验证

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Test: `tests/integration/async-ocr-flow.test.ts`
- Test: `tests/integration/async-policy-sync-flow.test.ts`

**Interfaces:**
- Consumes `npm run job:worker`, role bootstrap, job APIs and UI from Tasks 1–6.

- [ ] **Step 1: Write failing deployment/configuration test or assertion**

Add checks that the Docker Compose configuration contains `job-worker`, shares secrets/dependencies with Web, and documents worker startup, retry and role-bootstrap operations.

- [ ] **Step 2: Run checks to verify failure**

Run: `docker compose config && npm test -- --run tests/integration/async-ocr-flow.test.ts tests/integration/async-policy-sync-flow.test.ts`

Expected: compose lacks the job-worker service or integration coverage is incomplete.

- [ ] **Step 3: Add Worker service and operations documentation**

Use the existing application image and `app_env` secret; do not print secrets. Document migration order, the one-time admin bootstrap, job status meanings, safe re-run behavior and worker troubleshooting.

- [ ] **Step 4: Run final verification**

Run: `npx prisma generate --config prisma7.config.ts && npx tsc --noEmit && npm test && npm run build && docker compose config`

Expected: all commands pass; note any environment-caused browser test limitation separately.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml README.md docs/operations.md tests/integration/async-ocr-flow.test.ts tests/integration/async-policy-sync-flow.test.ts
git commit -m "docs: document async job operations"
```

## Plan Self-Review

- Spec coverage: Tasks 1–7 cover roles, durable queue, OCR, policy sync, review APIs/UI, Worker deployment, audits and all eight acceptance criteria.
- Type consistency: Tasks 1 and 2 define every enum/repository method consumed later; Task 3/4 both use `processAsyncJob`; Task 5 owns all human state transitions.
- Review focus: every listed concurrency, idempotency, missing-target and authorization case is pinned to an explicit task test.
- Scope: no Redis, approval workflow, ERP integration, batch workflows or notification subsystem is introduced.
