# Admin Configuration Center Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理员区交付可发布、可回退的费用类别字典与智能补单映射，并使识别建议与报销政策校验独立。

**Architecture:** Go 报销服务是业务配置唯一写入方；PostgreSQL 保存可编辑草稿、不可变发布版本、活动版本指针和审计。费用字典、类型映射与通用事由放在同一 `expense_catalog` 快照，避免发布时出现类别与映射不一致。现有可执行政策版本和 Node 政策来源沿用原存储，只在管理员导航中聚合。

**Tech Stack:** Go 1.27.1、PostgreSQL/pgx、React 19、TypeScript、Vitest、现有 Go OCR Worker 与 OpenAI-compatible 分类器。

**Spec:** `docs/admin-configuration-center-product-plan.md`（第 1–5、6、7 节第一阶段与验收 1–3、6、8）。后续见 `2026-11-12-admin-config-operations.md` 与 `2026-11-12-admin-config-knowledge-ai.md`。

## Global Constraints

- 首期企业统一一套配置；本地、测试、生产依靠独立数据库隔离，不跨环境自动复制。
- 分类建议、整单最终类别和 `CATEGORY_ALLOWED` 校验相互独立；模型证据门槛、OCR 金额来源和只读票据结果保持现有约束。
- 已发布配置不可改写；回退只切换活动版本指针，不修改已提交单据、已识别票据或审计。
- 保留当前 `expenseCategory`、`selectedExpenseCategories` 字符串 API 的兼容读取；新增稳定类别编码时做并行字段迁移，不能按名称猜测无法唯一映射的旧数据。
- 管理写操作仅 `ADMIN`，服务端重新核对当前角色；员工只能读取当前启用类别。秘密、重复票据测试豁免和文件安全限制不进入此模块。
- 每个任务均先写失败测试、再做最小实现、执行目标测试并单独 commit；执行时先建立隔离分支或工作树。Go 仓储集成测试使用**已迁移的隔离数据库** `TEST_REIMBURSEMENT_DATABASE_URL`，不得指向日常本地数据。

## Review Focus

- 两名管理员同时更新同一草稿：Task 1 的版本冲突测试，后提交者得到 409，不覆盖先提交者。
- 发布事务在写版本后失败：Task 1 的原子性测试，活动指针和审计保持旧版本。
- 停用被映射或政策引用的类别：Task 2 的校验测试，发布被拒且指出引用处。
- OCR 与配置发布并发：Task 3 的快照一致性测试，一张票据只使用一次读取到的映射版本。
- 未授权员工直接调用管理员路由：Task 1 的 HTTP 测试，读草稿、写入和历史均返回 403。

---

## Task 1: 配置版本底座与管理员 API

**Files:**
- Create: `services/reimbursement-api/db/migrations/000024_admin_config_versions.sql`
- Create: `services/reimbursement-api/internal/domain/config.go`
- Create: `services/reimbursement-api/internal/application/config_service.go`
- Create: `services/reimbursement-api/internal/store/config_repository.go`
- Create: `services/reimbursement-api/internal/transport/http/config_handler.go`
- Test: `services/reimbursement-api/internal/application/config_service_test.go`
- Test: `services/reimbursement-api/internal/store/postgres_config_repository_test.go`
- Test: `services/reimbursement-api/internal/transport/http/config_handler_test.go`
- Modify: `services/reimbursement-api/internal/transport/http/router.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`
- Modify: `api/openapi/reimbursement-v1.yaml`

**Interfaces:** `ConfigSnapshot { Domain string; Version int64; Payload json.RawMessage; PublishedAt time.Time }`；`ConfigRepository` 提供 `GetActive(ctx, domain)`, `SaveDraft(ctx, actorID, domain, expectedRevision, payload, note)`, `GetDraft(ctx, domain)`, `ApproveDraft(ctx, approverID, domain, draftRevision)`, `PublishDraft(ctx, actorID, domain, expectedRevision)`, `ActivateVersion(ctx, actorID, domain, expectedActiveVersion, targetVersion, note)`、`ListHistory(ctx, domain)`；`ConfigService.PreviewDraft` 对比草稿和活动版本。允许的 domain 为 `expense_catalog`、`form_options`、`feature_rollout`、`receipt_review`、`notification_templates`、`knowledge_runtime`、`model_runtime`；每个 domain 必须注册严格的 payload 验证器，未注册或没有初始活动版本的 domain 不允许发布或供业务读取。高风险域的批准人不得是草稿作者；数据库中 `(domain, version)` 唯一；草稿 revision 与活动指针版本使用乐观并发；重复发布同一草稿 revision 返回冲突；发布和回退在一个事务内写审计并切换指针。API 使用 `/api/v1/admin/config/{domain}`、`/draft`、`/preview`、`/approve`、`/publish`、`/history`、`/activate`；员工活动配置走 `/api/v1/config/{domain}`，Node/飞书 Worker 走带服务身份校验的 `/internal/v1/config/{domain}/active`。禁止任意 JSON 域名。

- [ ] **Step 1: 写失败测试。** 覆盖草稿版本冲突、发布后版本不可变、发布事务回滚、回退旧版本、作者不能自批、内部接口缺服务身份时拒绝、员工/财务复核员无写权限及跨域查询隔离。
- [ ] **Step 2: 验证 Red。** 在 `services/reimbursement-api` 运行 `go test ./internal/application ./internal/store ./internal/transport/http -run 'Config' -count=1`；新测试因接口缺失或断言失败而失败。
- [ ] **Step 3: 实现。** 建表与约束，按现有 `adminHandler.authorize` 模式接入角色校验；API 拒绝未知字段与过大 payload，配置验证器由各领域注册。每个已发布版本完整保存快照；发布/回退审计与活动指针同事务提交。
- [ ] **Step 4: 验证 Green。** 重跑目标测试，使用隔离 DB 执行仓储集成测试；检查 `git diff --check`。
- [ ] **Step 5: Commit。** `feat: add versioned admin configuration store`

## Task 2: 费用类别字典与映射校验

**Files:**
- Create: `services/reimbursement-api/internal/application/expense_catalog.go`
- Test: `services/reimbursement-api/internal/application/expense_catalog_test.go`
- Modify: `services/reimbursement-api/internal/application/config_service.go`
- Create: `services/reimbursement-api/db/migrations/000025_expense_catalog_baseline.sql`
- Modify: `services/reimbursement-api/internal/application/receipt_classification.go`
- Test: `services/reimbursement-api/internal/application/receipt_classification_test.go`
- Modify: `services/reimbursement-api/internal/infrastructure/receipt_classifier.go`
- Test: `services/reimbursement-api/internal/infrastructure/receipt_classifier_test.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Test: `services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion_test.go`
- Modify: `services/reimbursement-api/cmd/worker/main.go`

**Interfaces:** `ExpenseCatalog { Categories []Category; Mappings []ReceiptMapping }`；`Category { Code, Label string; Aliases []string; Enabled bool; SortOrder int }`；`ReceiptMapping { ReceiptType, CategoryCode, PurposeTemplate string }`；`ValidateExpenseCatalog(catalog ExpenseCatalog) []ConfigIssue`；`ResolveClassification(receiptType, evidence, confidence, ocrText string, catalog ExpenseCatalog) ClassificationSuggestion`。`CategoryCode` 稳定且唯一，`Label` 供 Web 展示；迁移时从现有五类映射和候选名称创建第一个已发布活动版本，保留原标签，并在读路径切换前核验该基线可读。模型接口只返回类型/证据/置信度，不接收 `CATEGORY_ALLOWED` 名单。

- [ ] **Step 1: 写失败测试。** 已发布规则只允许“餐饮费”时，证据充分的 `TAXI` 仍得到“市内交通费”建议；`OTHER` 得到“其他”；无证据、低置信仍为 `UNKNOWN`；停用类别、重复编码、缺失映射阻止发布；迁移后首个活动版本与现有映射等价。
- [ ] **Step 2: 验证 Red。** 运行 `go test ./internal/application ./internal/infrastructure -run 'Classification|ExpenseCatalog' -count=1`，确认策略耦合测试失败。
- [ ] **Step 3: 实现。** 先发布现有映射的基线快照，再以活动 `expense_catalog` 快照替换固定映射和 `AllowedReceiptCategories` 分类门槛；保留 `CATEGORY_ALLOWED` 在提交校验中的用途。配置不可用时使用进程中最后成功读取的完整快照并告警；首次启动没有有效快照则拒绝分类，不默默生成类别。
- [ ] **Step 4: 验证 Green。** 重跑目标包测试；用模型无效 JSON、超时、政策不允许“其他”三种样例验证 OCR 事实仍可保存且分类状态准确。
- [ ] **Step 5: Commit。** `feat: configure receipt categories independently of policy`

## Task 3: 稳定类别编码、历史兼容与策略校验

**Files:**
- Create: `services/reimbursement-api/db/migrations/000026_expense_category_codes.sql`
- Modify: `services/reimbursement-api/internal/domain/claim.go`
- Modify: `services/reimbursement-api/internal/domain/expense_item.go`
- Modify: `services/reimbursement-api/internal/store/claim_repository.go`
- Modify: `services/reimbursement-api/internal/store/expense_item_repository.go`
- Modify: `services/reimbursement-api/internal/store/submission_repository.go`
- Modify: `services/reimbursement-api/internal/application/policy_rules.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler.go`
- Modify: `api/openapi/reimbursement-v1.yaml`
- Test: `services/reimbursement-api/internal/store/postgres_expense_item_repository_test.go`
- Test: `services/reimbursement-api/internal/store/postgres_policy_submission_test.go`
- Test: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`

**Interfaces:** 新字段 `categoryCode`（单张识别明细）与 `selectedExpenseCategoryCodes`（整单最终选择）关联稳定字典编码；现有类别名称字段继续作为识别时/提交时的显示快照返回。新发布的 `CATEGORY_ALLOWED` 和 `CATEGORY_REQUIRED_FIELD` 规则按编码解析；旧已发布规则仍按原字符串语义执行，不改写历史政策。单据、明细和提交快照保存使用的 `expenseCatalogVersion`。唯一匹配的历史名称可回填编码；未知或一名多码保持旧名称并标记待人工选择。

- [ ] **Step 1: 写失败测试。** 字典改名后旧提交快照仍显示旧名；新单按编码校验；旧政策版本继续按原名匹配；人工最终类别与票据识别类别不同也能保存；OCR 重试不改人工选择。
- [ ] **Step 2: 验证 Red。** 运行 `go test ./internal/domain ./internal/store ./internal/application ./internal/transport/http -run 'CategoryCode|ExpenseCatalogVersion|Policy' -count=1`，确认新行为失败。
- [ ] **Step 3: 实现。** 前向兼容迁移、仓储/响应并行字段与提交快照；保留字符串读取和旧草稿的原有校验路径。任何新类别编码都要在当前发布字典中有效；停用只影响新选择，不破坏历史读取。
- [ ] **Step 4: 验证 Green。** 重跑目标测试；在隔离 DB 分别回放唯一名称、歧义名称、旧已提交单据和混合类别草稿。
- [ ] **Step 5: Commit。** `feat: persist stable category codes and snapshots`

## Task 4: 配置中心与员工表单

**Files:**
- Create: `apps/web/src/routes/admin-config-page.tsx`
- Create: `apps/web/src/routes/admin-config-page.test.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/features/claims/claim-application-form.tsx`
- Test: `apps/web/src/features/claims/claim-application-form.test.tsx`
- Modify: `apps/web/src/routes/policy-rules-page.tsx`
- Modify: `apps/web/src/routes/policy-sources-page.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:** `/admin/config` 为独立入口，含“业务字典／智能补单／发布记录”标签和到现有政策规则、政策来源的导航。员工端使用 `GET /api/v1/config/expense_catalog` 返回的启用类别列表，按编码多选；识别建议默认选中，允许员工独立更改整单值。管理员可编辑草稿、查看字段差异/影响预览、发布和激活旧版本；页面从 API 回读状态，不自行假定发布成功。

- [ ] **Step 1: 写失败测试。** 管理员与员工权限、类别多选默认值、人工更改与只读票据不互相覆盖、发布冲突后回读、回退后新草稿看到旧版本。
- [ ] **Step 2: 验证 Red。** 在 `apps/web` 运行 `npm test -- src/routes/admin-config-page.test.tsx src/features/claims/claim-application-form.test.tsx`，确认新交互未实现。
- [ ] **Step 3: 实现。** 复用现有表单和 API 客户端模式；保留旧路径可访问；草稿与已发布状态、错误、空数据、加载中均明确展示；多选键盘与屏幕阅读器可用。
- [ ] **Step 4: 验证 Green。** 重跑目标测试；运行 `npx tsc --noEmit` 与 `npm run build`（workdir `apps/web`）。
- [ ] **Step 5: Commit。** `feat: add admin catalog editor and category selector`

## Task 5: 阶段一端到端验收

**Files:**
- Modify: `docs/operations/receipt-driven-itemized-rollout.md`
- Modify: `docs/architecture.md`
- Test: `apps/web/e2e/claim-submission.spec.ts`
- Test: `services/reimbursement-api/internal/store/postgres_config_repository_test.go`

**Interfaces:** 验收以隔离环境和两名测试员工执行，测试管理员发布新映射后 Web 上传与飞书上传走同一 Go 识别链路；员工修改整单最终类别后可提交，政策不允许的类别只在校验时阻断。回退配置后新识别使用旧映射，历史识别与已提交快照不变。

- [ ] **Step 1: 写/补失败验收测试。** 覆盖发布、Web 与飞书同源、混合票据、策略阻断、回退及历史快照。
- [ ] **Step 2: 验证 Red。** 在隔离环境运行目标 E2E/集成测试，确认新验收项未满足。
- [ ] **Step 3: 完成联调与运行手册。** 记录迁移、首次字典发布、回退指针、异常恢复与配置版本查询；不得在手册放密钥或员工票面原文。
- [ ] **Step 4: 验证 Green。** 运行 Go `go test ./... -count=1`、Web `npm test`/`npm run build`、根目录 `npm test -- tests/unit tests/contract`；现场 Web/飞书链路另记录实际结果，不以模拟测试替代。
- [ ] **Step 5: Commit。** `test: verify admin catalog rollout and recovery`
