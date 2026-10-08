# 报销单号与票据识别结果展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 React 报销列表和工作台提供稳定的业务报销单号、票据 OCR 元数据与金额汇总，且不改变现有上传、校验和提交流程。

**Architecture:** PostgreSQL 负责并发安全地分配和保存报销单号，Go 报销服务持久化 OCR 解析出的规范字段并通过 OpenAPI 暴露查询投影，React 只格式化和展示该投影。PaddleOCR Python 服务继续只负责返回文本和总体置信度；Go OCR 适配器是标签化字段解析的唯一位置。

**Tech Stack:** PostgreSQL 16、Go 1.27.1、pgx/v5、OpenAPI 3.1、React 19、TypeScript、TanStack Query、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-08-claim-receipt-display-design.md`

## Global Constraints

- Go 报销 API 是 `reimbursement` schema 的唯一写入方；React 不直接访问数据库。
- 内部 `claim.id` 继续作为 URL、关联和鉴权标识；`claimNumber` 只作不可变业务展示标识。
- 报销单号格式固定为 `BXyyyyMMdd-四位流水号`，以 `Asia/Shanghai` 业务日生成；并发安全优先于无空号。
- 金额以 `BIGINT` 分保存和传输；缺失值必须为 `NULL`/`null`，不能用 0 或空字符串代替。
- OCR 解析无法可靠识别某字段时，票据仍可成为 `EXTRACTED`，且不得新增提交阻断规则。
- API 合同变更只能加字段，不改动现有路径或删除现有字段。
- 不记录 OCR 原文、对象键、Token、飞书身份或密钥。

## Review Focus

- 同一上海业务日并发创建的报销单必须得到不同的、格式正确的号码；该行为由 Task 1 的 PostgreSQL 并发测试覆盖。
- 迁移前已存在的单据、迁移后由历史导入直接写入的单据均不得因 `claim_number NOT NULL` 失败；该行为由 Task 1 的回填与默认值测试覆盖。
- OCR 识别到合法 `￥0.00` 时必须保留为 `0` 分，而未识别金额必须为 `nil`；该行为由 Task 2 的解析测试覆盖。
- 未含明确标签或含歧义数字的 OCR 文本不能猜测日期、金额或销售方；该行为由 Task 2 的负例测试覆盖。
- 列表中的金额合计只能包含 `EXTRACTED` 且有金额的附件，不能把处理中的附件或缺金额附件算入；该行为由 Task 3 的 PostgreSQL 投影测试覆盖。

---

## File Structure

```text
services/reimbursement-api/
  db/migrations/000010_claim_numbers_and_receipt_metadata.sql  # Schema、回填、每日计数器与默认号码函数
  internal/domain/claim.go                                      # Claim 业务号与汇总投影字段
  internal/domain/receipt.go                                    # 可空的 OCR 元数据字段
  internal/application/claim_number.go                           # 号码分配端口与内存测试实现
  internal/application/claim_service.go                          # 新建草稿时取得业务号
  internal/application/receipt_service.go                        # 票据读模型携带 OCR 元数据
  internal/infrastructure/ocr_client.go                          # 文本到规范 OCRResult 的标签化解析
  internal/store/claim_number_repository.go                      # PostgreSQL 号码函数调用
  internal/store/claim_repository.go                             # Claim 与附件汇总查询
  internal/store/receipt_repository.go                           # OCR 元数据读写
  internal/transport/http/claims_handler.go                      # 加性 JSON 响应字段
  internal/.../*_test.go                                         # Go 单元与 PostgreSQL 集成测试
api/openapi/reimbursement-v1.yaml                                # Claim / Receipt 响应合同
apps/web/src/
  api/generated/reimbursement.ts                                 # 与 OpenAPI 同步的 TypeScript 形状
  routes/claims-list-page.tsx                                    # 业务号和列表摘要
  routes/claim-workbench-page.tsx                                # 单据摘要和票据字段
  features/claims/*test.tsx, routes/*test.tsx                    # React 行为测试
```

### Task 1: 数据库迁移与并发安全的报销单号

**Files:**
- Create: `services/reimbursement-api/db/migrations/000010_claim_numbers_and_receipt_metadata.sql`
- Create: `services/reimbursement-api/internal/application/claim_number.go`
- Create: `services/reimbursement-api/internal/application/claim_number_test.go`
- Create: `services/reimbursement-api/internal/store/claim_number_repository.go`
- Create: `services/reimbursement-api/internal/store/claim_number_repository_test.go`
- Modify: `services/reimbursement-api/internal/domain/claim.go`
- Modify: `services/reimbursement-api/internal/application/claim_service.go`
- Modify: `services/reimbursement-api/internal/application/claim_service_test.go`
- Modify: `services/reimbursement-api/internal/store/claim_repository.go`
- Modify: `services/reimbursement-api/internal/store/postgres_claim_repository_test.go`
- Modify: `services/reimbursement-api/internal/store/legacy_import_repository.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`

**Interfaces:**
- Produces `type ClaimNumberGenerator interface { Next(context.Context, time.Time) (string, error) }` in `application`.
- Produces `store.NewPostgresClaimNumberGenerator(pool *pgxpool.Pool) application.ClaimNumberGenerator`, backed by `reimbursement.next_claim_number(TIMESTAMPTZ)`.
- Changes `domain.NewDraftClaim` to accept `claimNumber string`; `domain.Claim` gains `ClaimNumber string`, `ReceiptCount int`, `RecognizedReceiptCount int`, `TotalAmountCent *int64`, `MissingAmountReceiptCount int`.
- Changes `application.NewClaimService` to accept a `ClaimNumberGenerator` and a clock function, so tests can fix the Shanghai business date.

- [ ] **Step 1: Write failing number-format and immutability unit tests**

In `claim_number_test.go`, create a deterministic in-memory generator and assert `Next` returns `BX20261008-0001`, then `BX20261008-0002`, and resets to `BX20261009-0001` on the next Shanghai date. In `claim_service_test.go`, assert a created claim contains a number and that `Patch` cannot change it.

- [ ] **Step 2: Run the new application tests to verify RED**

Run: `go test ./internal/application -run 'Test.*ClaimNumber|TestCreateClaim.*Number' -count=1`

Expected: FAIL because no `ClaimNumberGenerator`, Claim field, or constructor dependency exists.

- [ ] **Step 3: Implement the application-level allocation seam and immutable domain field**

Add `ClaimNumberGenerator`, a test-only/in-memory implementation, and clock injection. `CreateClaim` must validate the draft input before requesting a number, pass the generated value to `NewDraftClaim`, and return it unchanged. Do not expose a patch field for it.

- [ ] **Step 4: Run the application tests to verify GREEN**

Run: `go test ./internal/application -run 'Test.*ClaimNumber|TestCreateClaim.*Number' -count=1`

Expected: PASS.

- [ ] **Step 5: Write a failing PostgreSQL allocator/legacy-insert integration test**

In `claim_number_repository_test.go`, with `TEST_REIMBURSEMENT_DATABASE_URL`, allocate two numbers concurrently for `2026-10-08T16:30:00Z` and assert distinct `BX20261009-0001` / `-0002` values. Insert a claim without specifying `claim_number` and assert the database default fills it. In `postgres_claim_repository_test.go`, update the service constructor and assert its persisted claim has the returned business number.

- [ ] **Step 6: Run the PostgreSQL allocator test to verify RED**

Run: `go test ./internal/store -run 'TestPostgresClaimNumber' -count=1`

Expected: FAIL because migration `000010` and `PostgresClaimNumberGenerator` do not exist.

- [ ] **Step 7: Create migration `000010_claim_numbers_and_receipt_metadata.sql` and PostgreSQL generator**

The migration must:

1. create `reimbursement.claim_number_counters`;
2. create `reimbursement.next_claim_number(TIMESTAMPTZ DEFAULT now())` using `Asia/Shanghai` and an atomic UPSERT/`RETURNING`;
3. add nullable `claim_number`, backfill existing claims by each local creation date and stable `(created_at, id)` order, seed counters from the highest backfilled daily value, add default/function, unique constraint and `NOT NULL`;
4. add nullable receipt metadata columns from the spec; and
5. grant `reimbursement_api` the required table and function privileges.

Implement `PostgresClaimNumberGenerator.Next(ctx, at)` as `SELECT reimbursement.next_claim_number($1)` and pass it from `cmd/api/main.go`. Update repository/legacy SQL inserts and all claim scans to include `claim_number`; legacy import may omit it so the database default is authoritative.

- [ ] **Step 8: Apply the migration to the disposable test database and run store tests**

Run: `Get-Content -Raw db/migrations/000010_claim_numbers_and_receipt_metadata.sql | psql "$env:TEST_REIMBURSEMENT_DATABASE_URL" -v ON_ERROR_STOP=1 && go test ./internal/store -run 'TestPostgresClaimNumber' -count=1`

Expected: PASS. For the local Compose database, use the equivalent `Get-Content -Raw ... | docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement`; do not hand-edit database rows to simulate the migration.

- [ ] **Step 9: Commit Task 1**

```bash
git add services/reimbursement-api/db/migrations/000010_claim_numbers_and_receipt_metadata.sql services/reimbursement-api/internal/application/claim_number.go services/reimbursement-api/internal/application/claim_number_test.go services/reimbursement-api/internal/application/claim_service.go services/reimbursement-api/internal/application/claim_service_test.go services/reimbursement-api/internal/domain/claim.go services/reimbursement-api/internal/store/claim_number_repository.go services/reimbursement-api/internal/store/claim_number_repository_test.go services/reimbursement-api/internal/store/claim_repository.go services/reimbursement-api/internal/store/postgres_claim_repository_test.go services/reimbursement-api/internal/store/legacy_import_repository.go services/reimbursement-api/cmd/api/main.go
git commit -m "feat: add reimbursement claim numbers"
```

### Task 2: 规范化 OCR 日期、金额和销售方

**Files:**
- Create: `services/reimbursement-api/internal/infrastructure/ocr_parser.go`
- Create: `services/reimbursement-api/internal/infrastructure/ocr_parser_test.go`
- Modify: `services/reimbursement-api/internal/domain/receipt.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service_test_helpers_test.go`
- Modify: `services/reimbursement-api/internal/infrastructure/ocr_client.go`
- Modify: `services/reimbursement-api/internal/infrastructure/ocr_client_test.go`

**Interfaces:**
- Produces `parseOCRReceipt(text string, confidence float64) application.OCRResult`.
- `application.OCRResult` gains `InvoiceDate *time.Time`, `TotalAmountCent *int64`, `SellerName *string`; `domain.Receipt` and `application.ReceiptView` expose the same optional values.
- `ReceiptService.ListReceipts` copies the optional values without converting `nil` into zero values.

- [ ] **Step 1: Write failing parser tests for valid Chinese invoice labels**

In `ocr_parser_test.go`, feed text containing `发票号码：26317000001513684420`、`开票日期：2026年05月01日`、`价税合计（小写）￥101.55`、`销售方名称：上海象鲜网络科技有限公司`. Assert invoice number, UTC date `2026-05-01`, `10155` cents, seller and confidence. Add a valid `￥0.00` case that asserts a non-nil zero pointer.

- [ ] **Step 2: Write failing conservative-parser negative tests and verify RED**

Add text with unlabelled dates/numbers and a malformed amount (`￥1.234`) and assert all optional metadata is nil. Run: `go test ./internal/infrastructure -run 'TestParseOCRReceipt' -count=1`.

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement `parseOCRReceipt` and extend OCR result types**

Use label-first regular expressions only. Normalize allowed date forms to midnight UTC, parse decimal RMB strings directly into integer cents, reject more than two decimal digits and overflowing values, and trim/limit seller text. Keep `HTTPReceiptOCRClient.Extract` responsible for joining pages and calculating the existing average confidence, then call the parser.

- [ ] **Step 4: Run parser and HTTP client tests to verify GREEN**

Run: `go test ./internal/infrastructure -run 'Test(ParseOCRReceipt|HTTPReceiptOCRClient)' -count=1`

Expected: PASS.

- [ ] **Step 5: Write failing receipt-view propagation test**

In `receipt_service_test_helpers_test.go` or a focused new application test, seed a fake extracted receipt with all optional values and assert `ListReceipts` returns the same values; seed a receipt with nil values and assert the returned pointers remain nil.

- [ ] **Step 6: Implement domain/view propagation and verify GREEN**

Update `Receipt`, `ReceiptView`, fake repository mutation, and `ListReceipts`. Run: `go test ./internal/application -run 'Test.*Receipt.*Metadata' -count=1`.

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add services/reimbursement-api/internal/domain/receipt.go services/reimbursement-api/internal/application/receipt_service.go services/reimbursement-api/internal/application/receipt_service_test_helpers_test.go services/reimbursement-api/internal/infrastructure/ocr_parser.go services/reimbursement-api/internal/infrastructure/ocr_parser_test.go services/reimbursement-api/internal/infrastructure/ocr_client.go services/reimbursement-api/internal/infrastructure/ocr_client_test.go
git commit -m "feat: parse receipt metadata from OCR text"
```

### Task 3: 持久化元数据并扩展 Go 查询/API 合同

**Files:**
- Modify: `services/reimbursement-api/internal/store/receipt_repository.go`
- Modify: `services/reimbursement-api/internal/store/postgres_receipt_repository_test.go`
- Create: `services/reimbursement-api/internal/store/postgres_claim_summary_repository_test.go`
- Modify: `services/reimbursement-api/internal/store/claim_repository.go`
- Modify: `services/reimbursement-api/internal/store/submission_repository.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `api/openapi/reimbursement-v1.yaml`
- Modify: `services/reimbursement-api/tests/openapi_compatibility_test.go`

**Interfaces:**
- `PostgresReceiptRepository.MarkExtracted(ctx, receiptID, result)` writes `invoice_date`, `total_amount_cent`, and `seller_name` with SQL null semantics.
- `ClaimRepository.FindOwned` and `ListOwned` return `Claim` with summary fields populated by one aggregate query, including `TotalAmountCent *int64`.
- `claimResponse` returns `claimNumber`, `receiptCount`, `recognizedReceiptCount`, `totalAmountCent`, and `missingAmountReceiptCount`; `receiptResponse` returns `invoiceDate`, `totalAmountCent`, and `sellerName`.

- [ ] **Step 1: Write failing PostgreSQL receipt persistence test**

Extend `TestPostgresReceiptRepositoryWritesAuditAndOutbox` to call `MarkExtracted` with a date, `10155` cents and seller. Query the receipt row and assert all values persist, while existing audit/outbox counts remain three.

- [ ] **Step 2: Run the receipt repository test to verify RED**

Run: `go test ./internal/store -run TestPostgresReceiptRepositoryWritesAuditAndOutbox -count=1`

Expected: FAIL because metadata is not written/read.

- [ ] **Step 3: Implement receipt SQL scans and `MarkExtracted` metadata persistence**

Add fields to every receipt SELECT, scanner and extraction UPDATE. Use nullable pgx scan targets and do not change status transitions or duplicate-invoice logic.

- [ ] **Step 4: Run the receipt repository test to verify GREEN**

Run: `go test ./internal/store -run TestPostgresReceiptRepositoryWritesAuditAndOutbox -count=1`

Expected: PASS.

- [ ] **Step 5: Write failing claim-summary repository test**

In `postgres_claim_summary_repository_test.go`, seed one claim with: an `EXTRACTED` receipt at `10155` cents, an `EXTRACTED` receipt with null amount, and a `READY_FOR_OCR` receipt at `999` cents. Assert `FindOwned` and `ListOwned` report count 3, recognized count 2, total `10155`, missing amount count 1, and never count the processing receipt amount.

- [ ] **Step 6: Run the claim-summary test to verify RED**

Run: `go test ./internal/store -run TestPostgresClaimRepositorySummarizesReceipts -count=1`

Expected: FAIL because claim repository selects do not join/aggregate receipts.

- [ ] **Step 7: Implement claim aggregation and HTTP/OpenAPI additions**

Use one `LEFT JOIN LATERAL` or grouped subquery in both owned-claim queries, with explicit `FILTER` conditions for receipt statuses and null amounts. Extend domain scan targets and submission repository scans for the added `claim_number`. Update handler response maps and OpenAPI nullable schemas; preserve all existing response properties and routes.

- [ ] **Step 8: Write and run HTTP/contract tests to verify GREEN**

In `claims_handler_test.go`, assert serialized claim/receipt JSON includes exact new field names and `null` for absent receipt metadata. Extend `openapi_compatibility_test.go` to require the Claim and Receipt schema properties. Run:

```bash
go test ./internal/store ./internal/transport/http ./tests -count=1
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add services/reimbursement-api/internal/store/receipt_repository.go services/reimbursement-api/internal/store/postgres_receipt_repository_test.go services/reimbursement-api/internal/store/postgres_claim_summary_repository_test.go services/reimbursement-api/internal/store/claim_repository.go services/reimbursement-api/internal/store/submission_repository.go services/reimbursement-api/internal/transport/http/claims_handler.go services/reimbursement-api/internal/transport/http/claims_handler_test.go services/reimbursement-api/tests/openapi_compatibility_test.go api/openapi/reimbursement-v1.yaml
git commit -m "feat: expose claim and receipt display metadata"
```

### Task 4: 同步 React 类型并展示报销单与票据详情

**Files:**
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/routes/claims-list-page.tsx`
- Modify: `apps/web/src/routes/claims-list-page.test.tsx`
- Modify: `apps/web/src/routes/claim-workbench-page.tsx`
- Modify: `apps/web/src/features/claims/claim-workbench.test.tsx`
- Modify: `apps/web/src/styles.css` (or the stylesheet currently imported by these routes)

**Interfaces:**
- TypeScript `Claim` gains `claimNumber`, `receiptCount`, `recognizedReceiptCount`, `totalAmountCent: number | null`, and `missingAmountReceiptCount`.
- TypeScript `Receipt` gains `invoiceDate: string | null`, `totalAmountCent: number | null`, and `sellerName: string | null`.
- A local formatter renders cents as `￥101.55` using `Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })`; absent values render `待补充`.

- [ ] **Step 1: Write failing React list tests**

Update `claims-list-page.test.tsx` fixture with `BX20261008-0001`, `10155` cents, three receipts, two recognized receipts and one missing amount. Assert the card shows the number, `￥101.55`, and `另有 1 份待补充`.

- [ ] **Step 2: Run the list test to verify RED**

Run: `npm --prefix apps/web test -- src/routes/claims-list-page.test.tsx`

Expected: FAIL because types and card rendering lack the fields.

- [ ] **Step 3: Implement Claim types and the list-card summary**

Align `reimbursement.ts` exactly with OpenAPI. Display `已识别金额` only when `totalAmountCent` is not null; append the missing-amount notice whenever its count is positive. Keep existing status and navigation behavior unchanged.

- [ ] **Step 4: Run the list test to verify GREEN**

Run: `npm --prefix apps/web test -- src/routes/claims-list-page.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing workbench tests for populated and absent OCR fields**

In `claim-workbench.test.tsx`, use one fully recognized receipt and one `EXTRACTED` receipt whose new fields are null. Assert the header shows the claim number; the first row shows invoice number, date, amount, seller and `96%`; the second explicitly shows `待补充` and no `￥0.00`.

- [ ] **Step 6: Run the workbench test to verify RED**

Run: `npm --prefix apps/web test -- src/features/claims/claim-workbench.test.tsx`

Expected: FAIL because the workbench only renders file name and invoice number.

- [ ] **Step 7: Implement accessible workbench metadata layout and responsive styling**

Add a header-level business number and receipt summary. Render each receipt’s labeled metadata in a semantic description list or labeled grid; preserve status tags, upload controls and submit flow. Add styles that stack the metadata at small widths without truncating the business number or currency amount.

- [ ] **Step 8: Run focused React tests and production build**

Run:

```bash
npm --prefix apps/web test -- src/routes/claims-list-page.test.tsx src/features/claims/claim-workbench.test.tsx
npm --prefix apps/web run build
```

Expected: PASS and a successful Vite build.

- [ ] **Step 9: Commit Task 4**

```bash
git add apps/web/src/api/generated/reimbursement.ts apps/web/src/routes/claims-list-page.tsx apps/web/src/routes/claims-list-page.test.tsx apps/web/src/routes/claim-workbench-page.tsx apps/web/src/features/claims/claim-workbench.test.tsx apps/web/src/styles.css
git commit -m "feat: show reimbursement numbers and receipt details"
```

### Task 5: 全链路回归与迁移验收

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Test: `tests/contract/openapi-contract.test.ts`

**Interfaces:**
- Documents a safe order: database backup, apply `000010`, restart migration-profile Go API/worker, then verify API and React UI.
- Produces no new endpoint, no Agent behavior change and no policy/submit-rule change.

- [ ] **Step 1: Write a failing documentation/contract assertion for the new response fields**

Add or extend `tests/contract/openapi-contract.test.ts` so it reads `api/openapi/reimbursement-v1.yaml` and requires `claimNumber`, `totalAmountCent`, `invoiceDate`, and `sellerName`. Add a short operations checklist requiring a backup and migration before restart.

- [ ] **Step 2: Run the contract test to verify RED**

Run: `npm test -- tests/contract/openapi-contract.test.ts`

Expected: FAIL until the OpenAPI field contract and runbook changes are complete.

- [ ] **Step 3: Write the deployment and rollback instructions**

Document that `000010` is forward-only; a rollback must restore from backup or deploy application compatibility code, not delete claim numbers or receipt fields. Include API checks for a newly created number, a recognized receipt’s metadata, and a null-metadata legacy receipt.

- [ ] **Step 4: Run complete service, web and repository regression suites**

Run:

```bash
go test ./...
npm --prefix apps/web test
npm test
docker compose --profile migration config --quiet
```

Expected: all suites pass and Compose configuration is valid. Record any pre-existing unrelated failures separately; do not hide them by weakening tests.

- [ ] **Step 5: Perform manual acceptance in the migration profile**

1. Start `docker compose --profile migration up -d --build` after applying the Go migration.
2. Create a new draft at `http://localhost:8088/claims`, upload a labeled invoice, and wait for OCR completion.
3. Refresh the list and workbench; verify number persistence, exact cents total, date, seller, confidence, and pending-field wording.
4. Open an old/existing receipt; verify it remains visible and missing new fields read `待补充`.
5. Run existing submission validation to verify no new metadata requirement blocks the claim.

- [ ] **Step 6: Commit Task 5**

```bash
git add README.md docs/operations.md tests/contract/openapi-contract.test.ts
git commit -m "docs: document receipt metadata rollout"
```

## Plan Self-Review

- **Spec coverage:** Task 1 covers business number storage, historical backfill and concurrency; Task 2 covers conservative OCR parsing and nullable semantics; Task 3 covers persistence, aggregation and HTTP/OpenAPI; Task 4 covers both requested UI surfaces; Task 5 covers deployment, compatibility and verification.
- **Type consistency:** `ClaimNumberGenerator.Next`, `ClaimNumber`, `TotalAmountCent`, `InvoiceDate`, and `SellerName` use the same names across all tasks. Monetary values are `*int64` in Go and `number | null` in TypeScript.
- **Review focus coverage:** all five focus cases map respectively to Task 1 Steps 5–8, Task 1 Step 5, Task 2 Step 1, Task 2 Step 2, and Task 3 Step 5.
- **Scope:** no task changes Agent orchestration, policy rules, submission requirements, or the Python OCR HTTP contract; those are explicitly excluded by the spec.
