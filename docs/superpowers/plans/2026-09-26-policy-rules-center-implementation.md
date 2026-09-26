# 报销政策规则中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让白名单政策管理员发布可追溯的结构化报销规则，并让报销校验、确认摘要和提交稳定执行该规则。

**Architecture:** 在 PostgreSQL 中引入不可变的已发布政策版本和受限规则配置；`PolicyRuleEngine` 只执行 Zod 校验过的四种规则类型。既有基础校验保持不变，应用层将其与政策结果合并，提交快照保存当时的版本和规则结果。

**Tech Stack:** Next.js 15 App Router、TypeScript、React 19、Prisma 7、PostgreSQL、Zod 4、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-26-policy-knowledge-base-design.md`

## Global Constraints

- 仅 `POLICY_ADMIN_FEISHU_OPEN_IDS` 白名单中的已登录飞书用户可写政策；不得信任浏览器提交的角色或 `open_id`。
- 只允许 `DRAFT` 政策版本编辑；已发布规则与版本不可原地修改。
- 第一版仅允许 `CLAIM_TOTAL_MAX`、`CATEGORY_ITEM_MAX`、`CATEGORY_ALLOWED`、`CATEGORY_REQUIRED_FIELD` 四种规则；不得引入脚本、SQL 或任意表达式执行。
- 校验与提交由确定性规则引擎决定；模型和飞书渠道不得写入规则、发布版本或绕过阻断。
- 没有有效政策时保留既有基础校验，并明确显示“尚未发布可执行政策”。
- 历史 `ValidationResult` 和 `SubmissionSnapshot` 必须能指出使用的政策版本和规则，后续发布不得重写其事实。
- 所有路由返回既有 `{ error: string }` 风格，不泄露内部数据库 ID、配置或密钥。

## Execution Status (2026-09-26)

| Task | Status | Evidence |
|---|---|---|
| Task 1: 政策持久化、配置与管理员授权 | Complete | `6c0978d`；政策版本/规则/审计迁移、白名单授权与仓储测试已落地。 |
| Task 2: 受限规则配置与确定性规则引擎 | In progress | `ff66e4f`；四类规则的基础求值与非法配置校验已实现，计划中的完整边界测试仍待补齐。 |
| Task 3: 将政策校验接入草稿、确认和提交 | In progress | `7fb308e`；校验 API、确认摘要与最终提交已接入当前发布版本；提交快照保存政策版本/规则摘要尚未实现。 |
| Task 4: 政策版本管理 API 与管理员工作台 | In progress | `40ae617`；已完成创建草稿与保存草稿规则 API；发布/归档/读取 API 与 Web 页面尚未实现。 |
| Task 5: 回归验证、运维说明与交付检查 | Not started | 等待规则中心能力完整后执行。 |

知识检索计划 `2026-09-26-policy-knowledge-retrieval-implementation.md` 尚未开始。

## Review Focus

- 空白、重复、非 `ou_` 格式或由逗号产生的空管理员白名单项必须不授予权限；由 Task 1 的配置与授权测试锁定。
- 并发管理员发布相同草稿或旧版本时只能有一个成功，另一个收到版本冲突；由 Task 3 的集成测试锁定。
- 金额恰等于上限、类别为空、费用明细没有类别以及多条规则同时命中时，结果必须稳定且不重复；由 Task 2 的领域测试锁定。
- 已提交报销单、未登录用户、他人草稿和没有有效政策时不得产生错误的规则结论或写入；由 Task 3 的路由与用例测试锁定。
- 已发布政策在被新版本替换后，旧提交快照和历史校验仍显示旧版本与规则摘要；由 Task 3 的仓储集成测试锁定。

---

## File structure

- `prisma/schema.prisma` 与 `prisma/migrations/<timestamp>_add_policy_rules/`：政策版本、规则、政策审计，以及验证/提交快照关联。
- `src/domain/policy-rule.ts`、`src/domain/policy-rule-engine.ts`：规则类型、配置 schema、确定性求值与显示 DTO。
- `src/server/config.ts`、`src/server/authorization.ts`：管理员白名单解析与服务端判定。
- `src/infrastructure/prisma/policy-repository.ts`：发布、版本冲突保护、查询当前有效政策和审计。
- `src/application/manage-policy-version.ts`、`src/application/validate-policy-claim.ts`：管理用例与基础/政策校验编排。
- `src/server/stored-claim-validation.ts`、`src/application/request-submission.ts`、`src/application/submit-claim.ts`：现有校验和提交接入。
- `app/api/policies/**`、`app/api/admin/policies/**`：只读政策与管理员管理 API。
- `app/(authenticated)/policies/page.tsx`、`app/(authenticated)/admin/policies/page.tsx`、`src/ui/policy-*.tsx`：政策展示、规则编辑和发布交互。
- `tests/unit/domain/policy-rule-engine.test.ts`、`tests/unit/server/policy-authorization.test.ts`、`tests/integration/policy-repository.test.ts`、`tests/integration/api/policy-*.test.ts`、`tests/e2e/policy-management.spec.ts`：分层验证。

### Task 1: 政策持久化、配置与管理员授权

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_policy_rules/migration.sql`
- Modify: `src/server/config.ts`
- Modify: `src/server/authorization.ts`
- Create: `src/infrastructure/prisma/policy-repository.ts`
- Test: `tests/unit/server/policy-authorization.test.ts`
- Test: `tests/integration/policy-repository.test.ts`

**Interfaces:**
- Produces: `PolicyVersionStatus`, `PolicyRuleType`, Prisma `PolicyVersion`, `PolicyRule`, `PolicyAuditEvent`; `isPolicyAdmin(actorId: string, employee: { feishuUserId: string | null }, config: AppConfig): boolean`; `PrismaPolicyRepository`.
- Consumes: `Employee`, `ValidationResult`, `SubmissionSnapshot`, `loadConfig()` and existing Prisma test client conventions.

- [ ] **Step 1: Write the failing authorization/config tests**

Add tests that parse a comma-separated `POLICY_ADMIN_FEISHU_OPEN_IDS`, trim entries, reject blank/nonmatching values, and return `false` for a session employee whose `feishuUserId` is missing or not listed.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test -- tests/unit/server/policy-authorization.test.ts`

Expected: FAIL because policy configuration and authorization exports do not exist.

- [ ] **Step 3: Add the minimal policy schema, migration, and authorization interfaces**

Add immutable `PolicyVersion`/`PolicyRule` records and policy audit records. Extend validation and submission persistence with nullable policy version/rule references or stable identifiers sufficient for historical reads. Add `policyAdminOpenIds: ReadonlySet<string>` to `AppConfig`, parse it once in `loadConfig`, and implement `isPolicyAdmin` from the authenticated employee record only. Create `PrismaPolicyRepository` with typed methods for draft creation, draft mutation guarded by `version`, current published lookup, immutable publication, archival, and audit append.

- [ ] **Step 4: Run focused unit and repository tests**

Run: `npm run test -- tests/unit/server/policy-authorization.test.ts tests/integration/policy-repository.test.ts`

Expected: PASS; publication is transactional and cannot mutate an existing published rule.

- [ ] **Step 5: Commit the persistence boundary**

```bash
git add prisma src/server src/infrastructure/prisma tests/unit/server tests/integration
git commit -m "feat: add policy version persistence"
```

### Task 2: 受限规则配置与确定性规则引擎

**Files:**
- Create: `src/domain/policy-rule.ts`
- Create: `src/domain/policy-rule-engine.ts`
- Modify: `src/domain/claim-validation.ts`
- Test: `tests/unit/domain/policy-rule-engine.test.ts`
- Test: `tests/unit/domain/claim-validation.test.ts`

**Interfaces:**
- Consumes: `PolicyRule` data from Task 1 and `ExpenseItem` fields (`amountCents`, `expenseCategory`, `participants`, `projectCode`).
- Produces: `parsePolicyRuleConfig(type: PolicyRuleType, value: unknown): ParsedPolicyRuleConfig`; `evaluatePolicyRules(input: { policyVersionId: string; rules: PolicyRuleInput[]; claim: PolicyClaimInput }): PolicyValidationIssue[]`; an extended `ValidationIssue` with optional safe `message`, `source`, `policyVersionId`, and `ruleCode` metadata.

- [ ] **Step 1: Write failing tests for every supported rule and boundary**

Cover: total exactly at/over cap; one matching category item exactly at/over cap; allowed and disallowed categories; category-required `participants` or `projectCode`; `BLOCKING` versus `WARNING`; invalid config; empty category; multiple ordered rule failures; and base validation remaining unchanged.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/unit/domain/policy-rule-engine.test.ts tests/unit/domain/claim-validation.test.ts`

Expected: FAIL because schemas and engine do not exist.

- [ ] **Step 3: Implement typed configs and `evaluatePolicyRules`**

Use discriminated Zod schemas keyed by the four `PolicyRuleType` values. Normalize only trimmed user-entered categories/field names, preserve rule order, and return a stable code of `POLICY_<ruleCode>` plus safe Chinese message metadata. Make malformed stored rules fail closed for publication/management validation, not silently become executable behavior.

- [ ] **Step 4: Run the domain tests**

Run: `npm run test -- tests/unit/domain/policy-rule-engine.test.ts tests/unit/domain/claim-validation.test.ts`

Expected: PASS, including all cap boundaries and severity cases.

- [ ] **Step 5: Commit the rule engine**

```bash
git add src/domain tests/unit/domain
git commit -m "feat: evaluate structured policy rules"
```

### Task 3: 将政策校验接入草稿、确认和提交

**Files:**
- Create: `src/application/validate-policy-claim.ts`
- Modify: `src/server/stored-claim-validation.ts`
- Modify: `src/application/request-submission.ts`
- Modify: `src/application/submit-claim.ts`
- Modify: `src/infrastructure/prisma/claim-repository.ts`
- Modify: `app/api/claims/[claimId]/validate/route.ts`
- Modify: `app/api/claims/[claimId]/submission-request/route.ts`
- Modify: `app/api/claims/[claimId]/submit/route.ts`
- Test: `tests/unit/application/validate-policy-claim.test.ts`
- Test: `tests/integration/api/claim-validation.test.ts`
- Test: `tests/integration/claim-submission.test.ts`
- Test: `tests/integration/policy-repository.test.ts`

**Interfaces:**
- Consumes: `evaluatePolicyRules()` from Task 2 and current-policy lookup from Task 1.
- Produces: `validateStoredClaimWithPolicy(input, policy): Promise<ValidationIssue[]>`; `SubmissionDeps.validate()` returns enriched issues plus policy version; `submissions.create()` accepts immutable policy snapshot data.

- [ ] **Step 1: Write failing application and API tests**

Seed an owner, a published policy and expense items. Assert blocking rules prevent confirmation and submit; warnings appear in preview but allow submit; no published policy preserves base validation; a newly published version does not change an earlier `SubmissionSnapshot`; stale publish/update requests return `409`.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/unit/application/validate-policy-claim.test.ts tests/integration/api/claim-validation.test.ts tests/integration/claim-submission.test.ts tests/integration/policy-repository.test.ts`

Expected: FAIL because claim validation does not load policy or persist the policy snapshot.

- [ ] **Step 3: Implement the validation and submission composition**

Load only the single active published version in the same request flow, combine base issues with `PolicyRuleEngine` results without changing their severity, and persist the evaluated policy version/rule summary with the submission transaction. Revalidate immediately before submit; never reuse only a browser preview or confirmation token as policy proof.

- [ ] **Step 4: Run focused tests and type check**

Run: `npm run test -- tests/unit/application/validate-policy-claim.test.ts tests/integration/api/claim-validation.test.ts tests/integration/claim-submission.test.ts tests/integration/policy-repository.test.ts && npx tsc --noEmit`

Expected: PASS; warnings are retained and only blocking results stop the flow.

- [ ] **Step 5: Commit the claim integration**

```bash
git add src app tests
git commit -m "feat: enforce policy rules for claims"
```

### Task 4: 政策版本管理 API 与管理员工作台

**Files:**
- Create: `app/api/policies/current/route.ts`
- Create: `app/api/admin/policies/route.ts`
- Create: `app/api/admin/policies/[policyVersionId]/route.ts`
- Create: `app/api/admin/policies/[policyVersionId]/publish/route.ts`
- Create: `app/(authenticated)/policies/page.tsx`
- Create: `app/(authenticated)/admin/policies/page.tsx`
- Create: `src/ui/policy-version-editor.tsx`
- Create: `src/ui/policy-rule-form.tsx`
- Modify: `app/(authenticated)/claims/[claimId]/page.tsx`
- Modify: `src/ui/validation-panel.tsx`
- Modify: `src/ui/claim-types.ts`
- Test: `tests/integration/api/policy-admin-routes.test.ts`
- Test: `tests/integration/api/policy-current-route.test.ts`
- Test: `tests/e2e/policy-management.spec.ts`

**Interfaces:**
- Consumes: Task 1 repository/authorization and Task 2 parsed configurations; Task 3 enriched validation issues.
- Produces: administrative draft/create/update/publish responses, a public current-policy read DTO, and UI that separates base and policy issues with source/version text.

- [ ] **Step 1: Write failing route and browser tests**

Test unauthenticated/ordinary employee `401`/`403`, allowed administrator CRUD and publish, body schema rejection, version conflict, and an employee seeing a blocking policy issue and policy version on their own claim. In Playwright, cover creation of a draft rule, invalid rule form feedback, publication confirmation, and loss of edit controls after publishing.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -- tests/integration/api/policy-admin-routes.test.ts tests/integration/api/policy-current-route.test.ts && npm run test:e2e -- tests/e2e/policy-management.spec.ts`

Expected: FAIL because routes and pages do not exist.

- [ ] **Step 3: Implement route parsing and responsive policy UI**

Make every write route obtain actor ID from the signed session, load the employee, and call `isPolicyAdmin`. Validate rule payloads server-side before repository calls. Use explicit forms for the four rule types, a non-destructive publication confirmation, clear Chinese validation messages, and disabled/read-only published controls. Extend the claim validation panel with a policy group showing rule name, severity and effective version, while retaining current base-validation copy.

- [ ] **Step 4: Run focused tests, lint and type check**

Run: `npm run test -- tests/integration/api/policy-admin-routes.test.ts tests/integration/api/policy-current-route.test.ts && npm run test:e2e -- tests/e2e/policy-management.spec.ts && npm run lint && npx tsc --noEmit`

Expected: PASS; no client-supplied identity can gain management access.

- [ ] **Step 5: Commit policy management UI**

```bash
git add app src/ui tests
git commit -m "feat: add policy rules management"
```

### Task 5: 回归验证、运维说明与交付检查

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `docs/feishu-integration.md`
- Test: existing `tests/**`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: operator instructions for administrator allowlist, migration/rollback safeguards, policy publishing and user-visible behavior.

- [ ] **Step 1: Write documentation acceptance checks**

Add a small checklist in the relevant docs for blank allowlist, no active policy, policy publication, warning versus blocking, history retention, and non-administrator behavior.

- [ ] **Step 2: Run the full non-E2E suite**

Run: `npm run test && npm run lint && npx tsc --noEmit`

Expected: PASS; existing OAuth, claims, OCR, Agent, deletion, submission and bot behavior remains covered.

- [ ] **Step 3: Run the browser regression suite**

Run: `npm run test:e2e`

Expected: PASS; no existing employee flow is broken by policy display.

- [ ] **Step 4: Commit documentation and verified policy rules milestone**

```bash
git add README.md docs
git commit -m "docs: explain policy rules operations"
```
