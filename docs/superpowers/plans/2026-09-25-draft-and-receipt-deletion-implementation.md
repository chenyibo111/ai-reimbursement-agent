# 草稿与票据删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让员工安全删除自己的草稿或草稿内单张票据，并同步清理 MinIO 原文件、关联业务数据与无效校验状态。

**Architecture:** 删除应用服务先以员工、草稿状态和版本预检对象键，再执行幂等对象删除，最后以相同版本条件执行 Prisma 事务。草稿硬删除依赖现有级联关系，并将最小删除事实写入独立审计表；票据删除显式移除关联费用和 AI 建议、刷新重复校验。前端复用一个可访问的危险操作确认弹窗，不使用浏览器原生确认框。

**Tech Stack:** Next.js 15 App Router、TypeScript、React、Prisma 7、PostgreSQL、MinIO/S3、Zod、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-25-draft-and-receipt-deletion-design.md`

## Global Constraints

- 仅当前员工拥有、状态为 `DRAFT` 且版本匹配的草稿允许删除。
- 浏览器仅可发送严格的 `{ expectedVersion: number }`；服务端重读所有删除对象与关联关系。
- 对象存储删除失败时不得改变数据库；对象存储删除必须可安全重试。
- 不得为已提交报销单提供删除入口或删除 API 成功路径。
- 不使用 `window.confirm`、`alert` 或 `prompt`；所有危险操作使用应用内可访问确认弹窗。
- 日志、HTTP 错误、普通审计和独立删除审计不得含对象键、附件字节、发票字段或凭证。
- `.env.local`、MinIO 凭证与生产数据绝不提交。

## Review Focus

1. 对象存储失败或部分草稿附件删除时，数据库必须仍完整且重试不报错。
2. 任何跨员工、跨草稿、已提交或版本过期请求必须不删除对象或数据库数据。
3. 删除票据后必须同时删除其费用明细与 AI 建议，且不能保留失效重复校验。
4. 删除草稿时普通草稿审计会级联删除，但独立删除审计必须保留最小事实。
5. 确认弹窗必须能取消、Escape 关闭、键盘聚焦恢复，并在失败时不误报成功。

---

### Task 1: 扩展删除存储与持久化边界

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_deletion_audit_events/migration.sql`
- Modify: `src/infrastructure/storage/object-store.ts`
- Create: `src/application/delete-claim-draft.ts`
- Create: `src/application/delete-receipt.ts`
- Modify: `src/infrastructure/prisma/claim-repository.ts`
- Modify: `src/infrastructure/prisma/receipt-repository.ts`
- Create: `tests/unit/application/delete-claim-draft.test.ts`
- Create: `tests/unit/application/delete-receipt.test.ts`

**Interfaces:**

- Produces `ObjectStore.delete({ key: string }): Promise<void>` and deletion services accepting `{ actorId, claimId, expectedVersion }` or `{ actorId, claimId, receiptId, expectedVersion }`.
- Produces persistence methods that return authorized object keys before storage deletion and perform guarded transactional deletion afterward.

- [ ] **Step 1: Write failing unit tests for deletion ordering.**

```ts
it("does not delete the draft record when object deletion fails", async () => {
  const store = { delete: vi.fn().mockRejectedValue(new Error("storage unavailable")) };
  await expect(deleteClaimDraft(input, deps({ store }))).rejects.toThrow("storage unavailable");
  expect(deleteDatabaseRecord).not.toHaveBeenCalled();
});

it("deletes a receipt's expense and proposal after its object", async () => {
  await deleteReceipt(receiptInput, deps());
  expect(store.delete).toHaveBeenCalledWith({ key: "claims/claim-1/receipts/receipt-1/file" });
  expect(deleteReceiptRecord).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 3 }));
});
```

- [ ] **Step 2: Run the new tests to verify they fail.**

Run: `npm test -- tests/unit/application/delete-claim-draft.test.ts tests/unit/application/delete-receipt.test.ts`

Expected: FAIL because deletion services and `ObjectStore.delete` do not exist.

- [ ] **Step 3: Add the data model and storage delete implementation.**

Add `DeletionAuditEvent` with independent `id`, `employeeId`, `claimId`, `operation`, `receiptCount`, and `createdAt`; it must not have a foreign key to `ClaimDraft`. Add the corresponding Prisma migration. Extend `ObjectStore` and `createS3ObjectStore` with `DeleteObjectCommand`; object deletion has no user-visible object-key output.

- [ ] **Step 4: Implement guarded deletion services.**

`deleteClaimDraft` obtains all draft object keys through a repository preflight that verifies ownership/status/version, deletes each key sequentially, then invokes a transaction that conditionally deletes the same draft and records `DeletionAuditEvent`. `deleteReceipt` performs equivalent preflight for one receipt, deletes its object, then conditionally removes proposals linked to its expense item, the expense item, receipt, stale duplicate validations, and writes `RECEIPT_DELETED`. Both map a changed draft/status/version to `version conflict`.

- [ ] **Step 5: Recompute remaining duplicate validation.**

Inside the receipt transaction, clear active `DUPLICATE_FILE`/`DUPLICATE_INVOICE` results for that draft and regenerate them from remaining receipt hashes, structured invoice values, and submitted claims for the same employee. Preserve unrelated validation results. Add a unit assertion proving a deleted duplicate no longer blocks its remaining draft.

- [ ] **Step 6: Run focused checks and commit.**

Run: `npm exec prisma generate --config prisma7.config.ts && npm test -- tests/unit/application/delete-claim-draft.test.ts tests/unit/application/delete-receipt.test.ts`

```bash
git add prisma src/application src/infrastructure/storage src/infrastructure/prisma tests/unit/application
git commit -m "feat: add guarded claim and receipt deletion services"
```

### Task 2: 增加受保护的删除 API

**Files:**

- Create: `app/api/claims/[claimId]/route.ts` DELETE export or modify the existing dynamic route
- Create: `app/api/claims/[claimId]/receipts/[receiptId]/route.ts`
- Create: `tests/integration/api/claim-deletion.test.ts`
- Create: `tests/integration/api/receipt-deletion.test.ts`

**Interfaces:**

- Consumes Task 1 services and session actor helper.
- Produces `DELETE /api/claims/:claimId` returning `204`, and `DELETE /api/claims/:claimId/receipts/:receiptId` returning `{ receiptId, version }`.

- [ ] **Step 1: Write failing route integration tests.**

```ts
it("deletes only an owned draft with an exact version", async () => {
  const response = await DELETE(requestForOwner({ expectedVersion: 0 }), params(claim.id));
  expect(response.status).toBe(204);
  await expect(prisma.claimDraft.findUnique({ where: { id: claim.id } })).resolves.toBeNull();
});

it.each(["other employee", "submitted claim", "stale version", "extra body field"])("rejects %s without deletion", async () => {
  // Assert non-2xx response and that claim, receipt and object-delete spy remain unchanged.
});
```

- [ ] **Step 2: Run the route tests to verify they fail.**

Run: `npm test -- tests/integration/api/claim-deletion.test.ts tests/integration/api/receipt-deletion.test.ts`

Expected: FAIL because delete route handlers do not exist.

- [ ] **Step 3: Implement strict route parsing and status mapping.**

Use `getSessionActorId` and `z.object({ expectedVersion: z.number().int() }).strict()`. Instantiate only configured server dependencies. Return `401`, `403`, `404`, `409`, and safe `502`/`500` errors per the spec; never expose S3/MinIO details. Do not accept client-provided object keys or related record IDs beyond the route receipt ID.

- [ ] **Step 4: Prove receipt side effects and audit behavior.**

Extend the receipt integration test to create an attached `ExpenseItem`, `AgentFieldProposal`, and duplicate result; after successful deletion assert all three are removed/recomputed and the claim version increments. Extend claim deletion test to assert `DeletionAuditEvent` remains after the claim disappears.

- [ ] **Step 5: Run focused checks and commit.**

Run: `npm test -- tests/integration/api/claim-deletion.test.ts tests/integration/api/receipt-deletion.test.ts && npx tsc --noEmit`

```bash
git add app/api/claims tests/integration/api
git commit -m "feat: expose guarded draft and receipt deletion APIs"
```

### Task 3: 实现共享危险操作确认与删除入口

**Files:**

- Create: `src/ui/destructive-confirmation-dialog.tsx`
- Modify: `src/ui/receipt-upload.tsx`
- Modify: `app/(authenticated)/claims/page.tsx`
- Modify: `app/(authenticated)/claims/[claimId]/page.tsx`
- Modify: `src/ui/claim-types.ts`
- Modify: `app/globals.css`
- Modify: `UX-CONTRACT.md`
- Create: `tests/e2e/draft-and-receipt-deletion.spec.ts`

**Interfaces:**

- Consumes the Task 2 DELETE endpoints and claim `version` included in list/detail DTOs.
- Produces `DestructiveConfirmationDialog` with `title`, `description`, `confirmLabel`, `isPending`, `error`, `onConfirm`, and `onClose`.

- [ ] **Step 1: Write a failing browser scenario.**

```ts
test("employee can cancel then delete a draft from the list", async ({ page }) => {
  // Open confirmation, press Escape, assert the row remains and focus returns to Delete.
  // Reopen, confirm, assert row disappears and a status message is announced.
});

test("employee can delete one receipt without deleting the draft", async ({ page }) => {
  // Upload/create two receipts, confirm deletion of one, assert one card remains and total/validation refresh.
});
```

- [ ] **Step 2: Run the browser scenario to verify it fails.**

Run: `npm run test:e2e -- tests/e2e/draft-and-receipt-deletion.spec.ts`

Expected: FAIL because no delete controls or confirmation dialog exist.

- [ ] **Step 3: Build the shared alert dialog.**

Render a portal-free app-owned `role="alertdialog"` with `aria-modal="true"`, labelled title/description, initial focus on Cancel, focus trapping for Tab/Shift+Tab, Escape close, and restoration to the trigger. Keep it open on request failure and announce the inline error. Add danger button CSS from existing `--danger` token without moving surrounding card/layout geometry.

- [ ] **Step 4: Add list and receipt actions.**

Extend the list DTO with `version`; show “删除草稿” only for `DRAFT`. On server-confirmed success, remove the list row and announce “草稿已删除”. Add “删除附件” to each receipt card; its confirmation names `receiptDisplayName(receipt)` and explains associated expense/Agent suggestion removal. On success use the existing claim refresh callback, keep current page content while refreshing, and announce “附件已删除”.

- [ ] **Step 5: Update UX contract and test responsive/error states.**

Add delete operations to the CRUD flow ledger with destructive confirmation, busy, success, conflict and storage-failure recovery. Run the browser scenario at desktop and 390px width; verify Escape/cancel/focus return, submitted-row absence, `409` recovery copy, and disabled busy controls.

- [ ] **Step 6: Commit the UI slice.**

```bash
git add src/ui app/(authenticated)/claims app/globals.css UX-CONTRACT.md tests/e2e
git commit -m "feat: add confirmed draft and receipt deletion controls"
```

### Task 4: 发布验证与运维说明

**Files:**

- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Document the operational contract.**

Document that only drafts can be deleted, objects are deleted before database records, storage failure leaves records intact for retry, and database failure may leave an already-deleted object safely retryable. Document the deletion-audit retention boundary and migration command; do not include credentials or object keys.

- [ ] **Step 2: Run static UI and project checks.**

Run:

```bash
python C:/Users/Yibo/.codex/plugins/cache/openai-curated-remote/frontend-design-premium/1.4.0/skills/frontend-design-premium/scripts/audit_project.py D:/AI/ai-reimbursement-agent --mode strict --no-write
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e -- tests/e2e/draft-and-receipt-deletion.spec.ts
npm run build
```

Expected: all commands exit `0`; audit report has no blocking ownership or interaction finding.

- [ ] **Step 3: Check dangerous-pattern and secret boundaries.**

Run: `rg -n "window\\.(confirm|alert|prompt)|S3_SECRET|objectKey" src app tests`

Expected: no browser-native confirmation; any object-key use remains server-only; no secret is in client code, docs, or tracked environment files.

- [ ] **Step 4: Commit documentation and verification.**

```bash
git add README.md docs UX-CONTRACT.md tests/e2e
git commit -m "docs: document safe reimbursement deletion operations"
```

## Manual Acceptance Checklist

- [ ] 草稿列表仅显示本人草稿的删除入口；已提交单据没有入口且接口拒绝删除。
- [ ] 删除草稿前可以取消或按 Escape，确认后列表行消失且独立删除审计保留。
- [ ] 删除附件后原始文件、票据、费用明细、关联 AI 建议一并消失，剩余校验准确。
- [ ] MinIO 删除失败、网络错误或版本冲突时，页面保留上下文并可重试，不误报成功。
- [ ] 员工不能借由 URL、请求 body 或过期页面删除他人、他人票据或已提交单据。
