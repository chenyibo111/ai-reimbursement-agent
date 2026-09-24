# Local OCR and Claims Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixture receipt extraction with private local PaddleOCR and deliver persistent authenticated claim listing plus immutable submitted-claim details.

**Architecture:** The Next.js app remains the only component with database and MinIO access. A private Python PaddleOCR service returns OCR blocks; a TypeScript provider converts them to conservative, auditable reimbursement fields. Claim list/detail projections are served from authenticated APIs; detail always reads a `SubmissionSnapshot`, while a signed 30-day Cookie maintains the employee session.

**Tech Stack:** Next.js 15, React 19, TypeScript, Prisma 7/PostgreSQL, AWS S3 SDK/MinIO, Docker Compose, Python 3.11/FastAPI/PaddleOCR, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-ocr-claims-ledger-design.md`

## Global Constraints

- Keep all receipt files within the local Docker deployment boundary; do not add cloud OCR calls.
- Use `HttpOnly; SameSite=Lax` Cookies and add `Secure` only in production; never store session data in Local Storage.
- Every employee-scoped API filters by the server-authenticated employee ID, never by a client-supplied ID.
- Submitted claim detail is read from the immutable `SubmissionSnapshot.payload`, never from mutable `ClaimDraft` records.
- OCR cannot fabricate a critical field: absent or ambiguous fields are `null` with low confidence and require employee confirmation.
- Preserve existing upload signature, size, page-count and ClamAV checks before any OCR operation.
- Do not stage or commit the pre-existing `docker-compose.yml` modification unless it is intentionally included in the OCR task and verified.

## Review Focus

- An expired or tampered 30-day Cookie returns 401 and redirects to Feishu login, not a different employee. Task 1 covers this.
- A keyword search containing SQL wildcard characters remains a literal case-insensitive search scoped to the owner. Task 2 covers this.
- A submitted claim whose mutable expense records later change still returns the original submitted snapshot. Task 2 covers this.
- An OCR response missing an amount or returning contradictory labeled amounts creates no countable expense and exposes a recoverable clarification. Task 4 covers this.
- A direct detail URL for another employee's claim returns 403 without leaking snapshot fields or the submission number. Tasks 2 and 3 cover this.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/server/session.ts` | Signed session payload with issued/expiry timestamps and secure verification. |
| `src/server/auth-cookies.ts` | 30-day Cookie serialization and expiration attributes. |
| `app/api/auth/session/route.ts` | Minimal authenticated session projection. |
| `src/application/list-claims.ts` | Owner-scoped list query contract and result type. |
| `src/application/get-submission-detail.ts` | Owner-scoped immutable snapshot detail contract. |
| `app/api/claims/route.ts` | Authenticated `GET` alongside existing draft `POST`. |
| `app/api/claims/[claimId]/detail/route.ts` | Submitted-snapshot detail endpoint. |
| `app/(authenticated)/claims/page.tsx` | Claims list screen. |
| `app/(authenticated)/claims/[claimId]/detail/page.tsx` | Read-only submitted-claim screen. |
| `src/infrastructure/extraction/paddle-receipt-extraction-provider.ts` | Calls local OCR and maps OCR blocks using conservative rules. |
| `ocr-service/` | Dockerfile, Python dependencies, FastAPI OCR boundary and tests. |

## Task 1: Durable signed session and default entry

**Files:**
- Modify: `src/server/session.ts`
- Modify: `src/server/auth-cookies.ts`
- Create: `app/api/auth/session/route.ts`
- Modify: `app/page.tsx`
- Modify: `app/api/auth/feishu/callback/route.ts`
- Modify: `tests/unit/server/auth-cookies.test.ts`
- Create: `tests/unit/server/session.test.ts`
- Create: `tests/integration/api/session.test.ts`

**Interfaces:**
- Produces `createSessionToken(actorId, secret, now?): string` and `getSessionActorId(request, now?): string`.
- Produces `GET /api/auth/session -> { employeeId: string }` for a valid session, otherwise 401.
- Consumes `SESSION_SECRET` and `sessionCookie()` from the Feishu callback.

- [ ] **Step 1: Write failing token and Cookie tests**

```ts
it("accepts an unexpired signed session and rejects an expired one", () => {
  const token = createSessionToken("employee-1", "secret", new Date("2026-09-24T00:00:00Z"));
  expect(getSessionActorId(requestFor(token), new Date("2026-10-01T00:00:00Z"))).toBe("employee-1");
  expect(() => getSessionActorId(requestFor(token), new Date("2026-10-25T00:00:00Z"))).toThrow("unauthenticated");
});

it("creates a 30 day persistent HttpOnly session cookie", () => {
  expect(sessionCookie("employee-1", "secret", false)).toContain("Max-Age=2592000");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/server/session.test.ts tests/unit/server/auth-cookies.test.ts`

Expected: FAIL because the existing payload has no expiry and Cookie max-age is 28800.

- [ ] **Step 3: Implement minimal signed-expiry behavior**

```ts
type SessionPayload = { actorId: string; issuedAt: number; expiresAt: number; sessionId: string };
const sessionDurationSeconds = 60 * 60 * 24 * 30;

export function createSessionToken(actorId: string, secret: string, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return signPayload({ actorId, issuedAt, expiresAt: issuedAt + sessionDurationSeconds, sessionId: randomUUID() }, secret);
}
```

Validate payload shape, HMAC signature and `expiresAt > now`; retain `unauthenticated` errors. Change `sessionCookie()` to use 30 days. Make root and the Feishu callback redirect to `/claims`. Implement `GET /api/auth/session` with the existing session validation.

- [ ] **Step 4: Run tests to verify green**

Run: `npm test -- tests/unit/server/session.test.ts tests/unit/server/auth-cookies.test.ts tests/integration/api/session.test.ts`

Expected: PASS, including 401 for malformed and expired Cookies.

- [ ] **Step 5: Commit**

```powershell
git add src/server/session.ts src/server/auth-cookies.ts app/page.tsx app/api/auth/session/route.ts app/api/auth/feishu/callback/route.ts tests/unit/server/session.test.ts tests/unit/server/auth-cookies.test.ts tests/integration/api/session.test.ts
git commit -m "feat: persist employee sessions for thirty days"
```

## Task 2: Owner-scoped list and immutable detail APIs

**Files:**
- Create: `src/application/list-claims.ts`
- Create: `src/application/get-submission-detail.ts`
- Modify: `src/infrastructure/prisma/claim-repository.ts`
- Modify: `app/api/claims/route.ts`
- Create: `app/api/claims/[claimId]/detail/route.ts`
- Modify: `app/api/claims/[claimId]/submission-request/route.ts`
- Modify: `app/api/claims/[claimId]/submit/route.ts`
- Modify: `tests/integration/api/claims.test.ts`
- Create: `tests/integration/api/claim-detail.test.ts`
- Modify: `tests/integration/claim-submission.test.ts`

**Interfaces:**
- Produces `GET /api/claims?status=&query=&from=&to=` returning `{ items, total }`.
- Produces `GET /api/claims/:claimId/detail` returning a submitted snapshot only.
- Consumes `getSessionActorId(request)` and Prisma `ClaimDraft` / `SubmissionSnapshot`.

- [ ] **Step 1: Write failing list/detail tests**

```ts
it("lists only the current employee's matching claims", async () => {
  const response = await GET(new Request("http://localhost/api/claims?query=%25", { headers: ownerCookie }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ items: [{ id: ownerClaim.id }] });
});

it("returns immutable submitted data after mutable expenses change", async () => {
  await prisma.expenseItem.update({ where: { id: expense.id }, data: { amountCents: 99999 } });
  await expect((await detailGET(ownerRequest(claim.id))).json()).resolves.toMatchObject({
    submissionNumber: "RB20260001", totalAmountCents: 38600,
  });
});

it("rejects another employee from submitted detail", async () => {
  expect((await detailGET(otherEmployeeRequest(claim.id))).status).toBe(403);
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `npm test -- tests/integration/api/claims.test.ts tests/integration/api/claim-detail.test.ts tests/integration/claim-submission.test.ts`

Expected: FAIL because list GET and the detail route do not exist, and the current snapshot lacks a detail projection.

- [ ] **Step 3: Implement minimal repository and route contracts**

```ts
export async function listClaims(actorId: string, input: ListClaimsInput, deps: ListClaimsDeps) {
  return deps.claims.listForEmployee(actorId, input);
}

export async function getSubmissionDetail(actorId: string, claimId: string, deps: SubmissionDetailDeps) {
  const detail = await deps.submissions.getByClaimId(claimId);
  if (!detail) throw new Error("submission not found");
  if (detail.employeeId !== actorId) throw new Error("forbidden");
  return detail;
}
```

Implement Prisma `listForEmployee` with `employeeId` mandatory and keyword `contains` filtering. Return only list fields. Join owner and `SubmissionSnapshot` for detail, return its immutable payload only when status is `SUBMITTED`. Extend the submit transaction payload with expense fields, sources and safe receipt-extraction summaries; never include `objectKey`. Map draft detail to 404 and submitted confirmation requests to 409.

- [ ] **Step 4: Run tests to verify green**

Run: `npm test -- tests/integration/api/claims.test.ts tests/integration/api/claim-detail.test.ts tests/integration/claim-submission.test.ts`

Expected: PASS with owner filtering, literal keyword handling, immutable snapshot proof, 404 for draft detail and 409 for submitted confirmation requests.

- [ ] **Step 5: Commit**

```powershell
git add src/application/list-claims.ts src/application/get-submission-detail.ts src/infrastructure/prisma/claim-repository.ts app/api/claims/route.ts app/api/claims/[claimId]/detail/route.ts app/api/claims/[claimId]/submission-request/route.ts app/api/claims/[claimId]/submit/route.ts tests/integration/api/claims.test.ts tests/integration/api/claim-detail.test.ts tests/integration/claim-submission.test.ts
git commit -m "feat: add employee claims ledger APIs"
```

## Task 3: Claims list, read-only detail and submission navigation

**Files:**
- Create: `app/(authenticated)/claims/page.tsx`
- Create: `app/(authenticated)/claims/page.module.css`
- Create: `app/(authenticated)/claims/[claimId]/detail/page.tsx`
- Create: `app/(authenticated)/claims/[claimId]/detail/page.module.css`
- Create: `src/ui/claims-list.tsx`
- Create: `src/ui/submission-detail.tsx`
- Modify: `app/(authenticated)/claims/[claimId]/page.tsx`
- Modify: `tests/e2e/claim-submission.spec.ts`
- Create: `tests/e2e/claims-ledger.spec.ts`
- Modify: `DESIGN.md`
- Modify: `UX-CONTRACT.md`

**Interfaces:**
- Consumes Task 2 list/detail JSON contracts.
- Produces `/claims` and `/claims/[claimId]/detail` routes.
- Consumes submit success and navigates with `router.replace`.

- [ ] **Step 1: Write failing browser flows**

```ts
test("restores an authenticated employee to the list after reload", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/");
  await expect(page).toHaveURL(/\/claims$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "我的报销单" })).toBeVisible();
});

test("shows a submitted claim as read-only detail", async ({ page }) => {
  await page.goto("/claims/" + claimId + "/detail");
  await expect(page.getByText("RB20260001")).toBeVisible();
  await expect(page.getByLabel("上传票据")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认并提交" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run test to verify red**

Run: `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; npm exec -- playwright test tests/e2e/claims-ledger.spec.ts`

Expected: FAIL because the list and detail UI do not exist and root does not redirect.

- [ ] **Step 3: Implement accessible list and detail UI**

```tsx
<header className={styles.header}>
  <Link className={styles.brand} href="/claims">AI 报销 <span>Agent</span></Link>
  <Link className="button-primary" href="/claims/new">发起报销</Link>
</header>
<h1>我的报销单</h1>
<ClaimsList initialFilters={filters} />
```

Create a cancellation-safe list fetch that keeps labelled status/query/date filters in the URL. Render a table on desktop and cards below 640px. Render detail entirely from snapshot fields and map `EXTRACTED` to “识别”, `USER_ENTERED` to “员工填写”, `SYSTEM_CALCULATED` to “系统计算”. Update the workbench navigation to `/claims`; on submit success call `router.replace("/claims/" + claim.id + "/detail")`. Detail has no upload, edit, chat, confirmation or submission action.

- [ ] **Step 4: Run browser and design checks**

Run: `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; npm exec -- playwright test tests/e2e/claim-submission.spec.ts tests/e2e/claims-ledger.spec.ts`

Expected: PASS for persisted reload, filtered list, submission navigation and read-only detail.

Run: `python C:\\Users\\Yibo\\.codex\\plugins\\cache\\openai-curated-remote\\frontend-design-premium\\1.4.0\\skills\\frontend-design-premium\\scripts\\audit_project.py D:\\AI\\ai-reimbursement-agent --mode strict --no-write`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add app/(authenticated)/claims/page.tsx app/(authenticated)/claims/page.module.css app/(authenticated)/claims/[claimId]/detail/page.tsx app/(authenticated)/claims/[claimId]/detail/page.module.css app/(authenticated)/claims/[claimId]/page.tsx src/ui/claims-list.tsx src/ui/submission-detail.tsx tests/e2e/claim-submission.spec.ts tests/e2e/claims-ledger.spec.ts DESIGN.md UX-CONTRACT.md
git commit -m "feat: add claims list and submitted detail views"
```

## Task 4: Private PaddleOCR and conservative extraction

**Files:**
- Modify: `src/infrastructure/storage/object-store.ts`
- Modify: `src/infrastructure/extraction/receipt-extraction-provider.ts`
- Create: `src/infrastructure/extraction/paddle-receipt-extraction-provider.ts`
- Create: `src/infrastructure/extraction/receipt-extraction-provider-factory.ts`
- Modify: `app/api/claims/[claimId]/receipts/[receiptId]/extract/route.ts`
- Modify: `src/server/config.ts`
- Modify: `.env.example`
- Create: `ocr-service/Dockerfile`
- Create: `ocr-service/requirements.txt`
- Create: `ocr-service/app/main.py`
- Create: `ocr-service/tests/test_main.py`
- Modify: `docker-compose.yml`
- Create: `tests/unit/infrastructure/paddle-receipt-extraction-provider.test.ts`
- Create: `tests/integration/api/receipt-extraction-provider.test.ts`

**Interfaces:**
- Extends object store with `get({ key }): Promise<Uint8Array>`.
- Produces `PaddleReceiptExtractionProvider.extract({ objectKey, mimeType })`.
- Produces private `POST /extract` returning `{ modelVersion, pages: Array<{ text, confidence }> }`.

- [ ] **Step 1: Write failing provider behavior tests**

```ts
it("maps labelled OCR fields without inventing an amount", async () => {
  const provider = new PaddleReceiptExtractionProvider({
    objects: { get: async () => imageBytes },
    ocr: { extract: async () => ({ modelVersion: "paddle-test", pages: [{ text: "发票号码：12345678\n开票日期：2026年09月20日\n销售方：示例商店", confidence: 0.98 }] }) },
  });
  await expect(provider.extract({ objectKey: "claims/a", mimeType: "image/png" })).resolves.toMatchObject({
    invoiceNumber: { value: "12345678" },
    totalAmountCents: { value: null, confidence: 0 },
  });
});

it("rejects fixture provider outside tests", () => {
  expect(() => createReceiptExtractionProvider({ provider: "fixture", environment: "production" })).toThrow("fixture provider is not allowed");
});
```

- [ ] **Step 2: Run test to verify red**

Run: `npm test -- tests/unit/infrastructure/paddle-receipt-extraction-provider.test.ts tests/integration/api/receipt-extraction-provider.test.ts`

Expected: FAIL because no Paddle provider, provider factory or private OCR contract exists.

- [ ] **Step 3: Implement the private service and provider**

```python
@app.post("/extract")
async def extract(file: UploadFile) -> dict:
    if file.content_type not in {"image/jpeg", "image/png", "application/pdf"}:
        raise HTTPException(status_code=415, detail="unsupported media type")
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large")
    return {"modelVersion": MODEL_VERSION, "pages": recognize(content, file.content_type)}
```

Add `GetObjectCommand` to the object store and pass retrieved bytes to the provider. TypeScript calls `OCR_SERVICE_URL` with a timeout and parses lines only from explicit label/format matches. Normalize CNY decimals to cents. Multiple contradictory totals or absent labels yield `null` at confidence zero. The extraction route selects the factory provider, writes Paddle version and marks receipt `FAILED` on OCR error without creating an expense. Add an `ocr` Compose service with `expose: ["8000"]`, no `ports`, and a health check.

- [ ] **Step 4: Run tests and compose verification**

Run: `npm test -- tests/unit/infrastructure/paddle-receipt-extraction-provider.test.ts tests/integration/api/receipt-extraction-provider.test.ts`

Expected: PASS, including no invented amount and persisted failed extraction.

Run: `docker compose config`

Expected: PASS and no OCR host port mapping.

Run: `docker compose up -d ocr`

Expected: OCR becomes healthy before manual application extraction.

- [ ] **Step 5: Commit**

```powershell
git add src/infrastructure/storage/object-store.ts src/infrastructure/extraction/receipt-extraction-provider.ts src/infrastructure/extraction/paddle-receipt-extraction-provider.ts src/infrastructure/extraction/receipt-extraction-provider-factory.ts app/api/claims/[claimId]/receipts/[receiptId]/extract/route.ts src/server/config.ts .env.example ocr-service docker-compose.yml tests/unit/infrastructure/paddle-receipt-extraction-provider.test.ts tests/integration/api/receipt-extraction-provider.test.ts
git commit -m "feat: extract receipts with private paddleocr"
```

## Task 5: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `UX-CONTRACT.md`
- Modify: `tests/unit/server/config.test.ts`

**Interfaces:**
- Consumes the preceding runtime and browser contracts.
- Produces accurate local startup and manual acceptance instructions.

- [ ] **Step 1: Write failing documentation consistency test**

```ts
it("documents paddleocr as the normal local provider", async () => {
  const readme = await readFile("README.md", "utf8");
  expect(readme).toContain('RECEIPT_EXTRACTION_PROVIDER="paddleocr"');
});
```

- [ ] **Step 2: Run test to verify red**

Run: `npm test -- tests/unit/server/config.test.ts`

Expected: FAIL because local README and sample configuration select fixture.

- [ ] **Step 3: Document the verified runtime path**

```markdown
1. Run `docker compose up -d` and wait for `ocr` and `clamav` to become healthy.
2. Set `RECEIPT_EXTRACTION_PROVIDER="paddleocr"` and `OCR_SERVICE_URL` for the host-run Next server.
3. Sign in once with Feishu; `/claims` remains available for 30 days unless the employee signs out.
4. Upload a de-identified receipt. A field must come from OCR or be marked for confirmation; it must never read `FIXTURE-INVOICE`.
```

Add model-download, CPU-first and local-data-boundary notes plus an unhealthy-OCR troubleshooting section.

- [ ] **Step 4: Run complete verification**

Run: `npm exec tsc -- --noEmit`

Run: `npm run lint`

Run: `npm test`

Run: `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; npm exec -- playwright test`

Run: `docker compose config`

Run: `python C:\\Users\\Yibo\\.codex\\plugins\\cache\\openai-curated-remote\\frontend-design-premium\\1.4.0\\skills\\frontend-design-premium\\scripts\\audit_project.py D:\\AI\\ai-reimbursement-agent --mode strict --no-write`

Expected: every command exits 0. Stop the development server before `npm run build`, run `npm run build`, restart the server, then manually test login persistence, list filtering, read-only detail and one de-identified receipt upload.

- [ ] **Step 5: Commit**

```powershell
git add README.md .env.example UX-CONTRACT.md tests/unit/server/config.test.ts
git commit -m "docs: document local ocr reimbursement flow"
```

