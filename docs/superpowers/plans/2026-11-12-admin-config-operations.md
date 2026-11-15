# Admin Configuration Center Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员在配置中心管理现有表单选项、智能补单灰度、票据复核阈值和通知模板，并使各项变更只影响预期的新业务事件。

**Architecture:** 依赖基础阶段的 Go 配置版本仓储和管理员发布 API。每个运营领域独立版本与活动指针，避免灰度变更同时发布复核阈值。Go 负责灰度和票据复核判定；Node/飞书 Worker 只读取已发布通知快照，不另建写入入口。策略读取失败时不得放松安全校验。

**Tech Stack:** Go/PostgreSQL、React/TypeScript/Vitest、Node Agent/Vitest、现有飞书 Worker 与 Go OCR Worker。

**Spec:** `docs/admin-configuration-center-product-plan.md`（第 3–6 节、第二阶段与验收 4–6、8）。**Depends on:** `2026-11-12-admin-config-foundation.md` Tasks 1–5。

## Global Constraints

- 复用基础阶段 `ConfigRepository` 与 `/api/v1/admin/config/{domain}` 生命周期；领域依次为 `form_options`、`feature_rollout`、`receipt_review`、`notification_templates`。
- 当前两侧员工表虽有 `department` 字段，身份同步链路没有传递部门。部门灰度必须先接入可信目录的部门 ID 并完成双侧同步；没有可信来源时禁止发布 `DEPARTMENTS` 模式，不以空值或员工自填部门猜测成员归属。
- 灰度只影响新建草稿；调整复核策略只影响后续 OCR；通知模板版本在消息入队时固定。历史单据、案件、消息和审计不可被配置发布重写。
- 重复内容、已提交发票号重复、恶意文件扫描及 20 MB 文件限制不是可关闭的业务参数；本地测试豁免不进生产配置中心。
- 高风险域发布采用两名不同 `ADMIN` 身份的提交/复核记录；没有可复核人时保持草稿，不以单人自批绕过。所有操作按当前数据库角色授权，不信任浏览器角色字段。
- 每任务先写失败测试、运行 Red、最小实现、运行 Green，再单独 commit。仓储测试只用隔离、已迁移的 `TEST_REIMBURSEMENT_DATABASE_URL`。

## Review Focus

- 员工没有部门属性但灰度配置选了该部门：Task 2 的测试，保持未启用且留下可解释状态。
- 1% 灰度在多实例和重启后漂移：Task 2 的测试，同一员工始终得到同一结果。
- 复核阈值读取失败：Task 3 的测试，继续使用最后一个有效阈值或停止识别，不降低安全门槛。
- 模板含伪造链接/未授权变量：Task 4 的发布校验测试，拒绝发布且不发送票面全文。
- 模板发布与通知投递并发：Task 4 的测试，同一通知使用入队时锁定的模板版本。

---

## Task 1: 表单选项与提示语

**Files:**
- Create: `services/reimbursement-api/internal/application/form_options.go`
- Test: `services/reimbursement-api/internal/application/form_options_test.go`
- Modify: `services/reimbursement-api/internal/application/config_service.go`
- Modify: `services/reimbursement-api/internal/transport/http/config_handler.go`
- Create: `apps/web/src/routes/admin-form-options-page.tsx`
- Test: `apps/web/src/routes/admin-form-options-page.test.tsx`
- Modify: `apps/web/src/features/claims/claim-application-form.tsx`
- Test: `apps/web/src/features/claims/claim-application-form.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `FormOptions { CategoryHelpText string; ProjectCodeMode "FREE_TEXT"|"CATALOG"; ProjectCodes []{Code, Label, Enabled}; FieldOrder []string }`；`ValidateFormOptions` 仅接受现有字段标识，项目主数据未接入时强制 `FREE_TEXT`。员工端 `GET /api/v1/config/form_options` 只暴露当前生效的展示值，不暴露草稿。

- [ ] **Step 1: 写失败测试。** 配置变更后新打开表单显示新提示/顺序；未知字段被拒；项目主数据缺失时不能发布伪造的有效项目列表；已有草稿值不因选项停用而丢失。
- [ ] **Step 2: 验证 Red。** 在 Go 模块运行 `go test ./internal/application ./internal/transport/http -run 'FormOptions' -count=1`，在 `apps/web` 运行 `npm test -- src/routes/admin-form-options-page.test.tsx src/features/claims/claim-application-form.test.tsx`。
- [ ] **Step 3: 实现。** 接入配置验证、员工只读接口、管理员编辑页；只更新现有字段展示，不引入任意动态字段引擎。
- [ ] **Step 4: 验证 Green。** 重跑目标测试、Web 类型检查与构建，核对旧草稿回显。
- [ ] **Step 5: Commit。** `feat: configure existing claim form options`

## Task 2: 智能补单灰度范围

**Files:**
- Create: `services/reimbursement-api/internal/application/feature_rollout.go`
- Test: `services/reimbursement-api/internal/application/feature_rollout_test.go`
- Modify: `services/reimbursement-api/internal/application/claim_service.go`
- Test: `services/reimbursement-api/internal/application/claim_service_test.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`
- Modify: `services/reimbursement-api/internal/store/employee_member_repository.go`
- Modify: `services/reimbursement-api/internal/application/employee_identity.go`
- Modify: `services/reimbursement-api/internal/store/employee_identity_repository.go`
- Modify: `services/reimbursement-api/internal/transport/http/internal_employee_handler.go`
- Modify: `src/application/ensure-employee-identity.ts`
- Modify: `src/infrastructure/reimbursement/employee-provisioning-client.ts`
- Test: `tests/unit/application/ensure-employee-identity.test.ts`
- Create: `apps/web/src/routes/admin-feature-rollout-page.tsx`
- Test: `apps/web/src/routes/admin-feature-rollout-page.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `FeatureRollout { Mode "OFF"|"EMPLOYEES"|"DEPARTMENTS"|"PERCENT"|"ALL"; EmployeeIDs []string; DepartmentIDs []string; Percent int; Salt string }`；`IsEnabledForEmployee(config, employeeID, verifiedDepartmentID)` 使用稳定哈希 `feature + employeeID + salt`，`Percent` 限 0–100。配置写入前校验员工/部门标识存在且有效；把可信目录的部门 ID 作为可选身份属性同步到 Node/Go 员工记录，并记录来源/同步时间。若当前 SSO/飞书身份链路不能提供可验证的部门 ID，先禁用 `DEPARTMENTS` 发布并将目录接入列为该模式的上线门槛。旧 `REIMBURSEMENT_ITEMIZED_EMPLOYEE_IDS` 在过渡期作为未发布配置时的启动回退，发布后只读配置生效。

- [ ] **Step 1: 写失败测试。** 两名测试员工名单切换、同一员工跨进程稳定百分比、可信部门同步与来源校验、缺失部门属性时禁止发布或不启用、发布后只影响新草稿、配置撤回不删除已有明细。
- [ ] **Step 2: 验证 Red。** 运行 `go test ./internal/application ./internal/store -run 'FeatureRollout|ItemizedEmployee' -count=1` 与目标 Web 页面测试。
- [ ] **Step 3: 实现。** Go 创建草稿时按当前活动灰度快照决策并记录版本；先补可信目录部门同步，再启用部门模式。管理员页面展示预计范围和当前环境，不能跨环境复制测试名单；可信部门来源暂不可用时页面明确展示该模式不可发布。
- [ ] **Step 4: 验证 Green。** 重跑测试；在隔离环境连续新建草稿验证灰度名单、撤回及旧草稿可读性。
- [ ] **Step 5: Commit。** `feat: manage itemized rollout in admin config`

## Task 3: OCR 复核阈值与影响预览

**Files:**
- Create: `services/reimbursement-api/internal/application/receipt_review_config.go`
- Test: `services/reimbursement-api/internal/application/receipt_review_config_test.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/application/submission_service.go`
- Modify: `services/reimbursement-api/internal/store/submission_repository.go`
- Test: `services/reimbursement-api/internal/application/extract_receipt_test.go`
- Test: `services/reimbursement-api/internal/store/postgres_review_case_repository_test.go`
- Create: `apps/web/src/routes/admin-review-config-page.tsx`
- Test: `apps/web/src/routes/admin-review-config-page.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `ReceiptReviewConfig { LowOCRConfidenceThreshold float64; ReasonLabels map[string]string }`，默认 `0.70`；允许范围须先由样本评估确定并写入验证器，不能由管理员把安全检查设为无效值。识别时将阈值配置版本写入票据/案件；最终提交只读取票据复核状态和当时判定，不拿最新阈值重新放行旧票据。

- [ ] **Step 1: 写失败测试。** 阈值 `0.70` 边界、阈值变更前后两张票据、已有案件不自动关闭、读取失败不放行、重复票和恶意文件检查不能被配置关闭。
- [ ] **Step 2: 验证 Red。** 运行 `go test ./internal/application ./internal/store -run 'ReviewConfig|LowOCRConfidence' -count=1` 与目标 Web 页面测试。
- [ ] **Step 3: 实现。** 替换散落的 `0.7` 判定，给管理员提供脱敏样本影响预览；发布需不同管理员复核；复核原因文案可配置但原因编码不变。
- [ ] **Step 4: 验证 Green。** 重跑目标测试并验证复核案件状态和旧提交快照不变。
- [ ] **Step 5: Commit。** `feat: configure OCR review threshold safely`

## Task 4: 通知模板与事件开关

**Files:**
- Create: `services/reimbursement-api/internal/application/notification_config.go`
- Test: `services/reimbursement-api/internal/application/notification_config_test.go`
- Create: `src/infrastructure/reimbursement/config-client.ts`
- Test: `tests/unit/infrastructure/config-client.test.ts`
- Create: `src/application/render-configured-notification.ts`
- Test: `tests/unit/application/render-configured-notification.test.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated_timestamp>_notification_template_snapshot/migration.sql`
- Modify: `src/worker/agent-event-runtime.ts`
- Test: `tests/unit/worker/agent-event-runtime.test.ts`
- Create: `src/infrastructure/prisma/agent-event-notification-snapshot-repository.ts`
- Test: `tests/integration/agent-event-notification-snapshot-repository.test.ts`
- Modify: `services/agent/src/events/receipt-notification.ts`
- Test: `services/agent/src/events/receipt-notification.test.ts`
- Modify: `src/application/deliver-receipt-extraction-notifications.ts`
- Modify: `src/infrastructure/prisma/receipt-extraction-notification-repository.ts`
- Test: `tests/integration/receipt-extraction-notification-repository.test.ts`
- Create: `apps/web/src/routes/admin-notification-config-page.tsx`
- Test: `apps/web/src/routes/admin-notification-config-page.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `NotificationConfig` 以事件码和渠道为键，含 `enabled`、`template`、`version`；先清点并注册现有“识别完成／需补充／进入复核／提交成功”等真实事件码和 Web/飞书渠道，未接入发送链路的事件不得在 UI 假装可启用。`renderConfiguredNotification(template, safeVariables)` 只替换白名单变量，不执行表达式。`config-client.ts` 用服务身份读取 Go `/internal/v1/config/{domain}/active` 并校验版本/payload。作业通知复用现有 `ReceiptExtractionNotification`（`jobId` 唯一）：入队时固定事件开关和模板版本；OCR 完成后首次可投递处理时，在同一通知行原子写入安全文案，再发送。事件流通知按 `eventId` 唯一持久化模板版本和渲染文案，发送前完成保存。两条路径重试都复用固定文案和原有幂等 UUID。旧通知没有版本时沿用原文案，避免迁移期重发差异。

- [ ] **Step 1: 写失败测试。** 缺失金额、混合票、分类失败、非法变量、外链、过长输出、入队与投递之间模板更新、作业与事件流投递失败后重试仍用旧版本和原文案、未接入事件不能发布。
- [ ] **Step 2: 验证 Red。** 运行 `npm test -- tests/unit/application/render-configured-notification.test.ts tests/unit/infrastructure/config-client.test.ts tests/unit/worker/agent-event-runtime.test.ts tests/integration/receipt-extraction-notification-repository.test.ts tests/integration/agent-event-notification-snapshot-repository.test.ts services/agent/src/events/receipt-notification.test.ts` 与目标 Web 页面测试。
- [ ] **Step 3: 实现。** 扩展现有入队记录和事件流快照记录的模板版本、渲染文案并保持原有幂等 UUID/退避；禁用事件不入队或不发送。管理员编辑器提供真实变量样例的预览与禁用开关；Web 提示与飞书文案分渠道配置。
- [ ] **Step 4: 验证 Green。** 重跑目标测试与受影响的 Worker 测试；模拟重复事件和投递失败，不重复执行业务动作。
- [ ] **Step 5: Commit。** `feat: version employee notification templates`

## Task 5: 阶段二综合验收

**Files:**
- Modify: `docs/operations/receipt-driven-itemized-rollout.md`
- Modify: `docs/operations.md`
- Test: `apps/web/e2e/claim-submission.spec.ts`
- Test: `tests/contract/reimbursement-routing.test.ts`

**Interfaces:** 验收覆盖管理员发布配置、两个灰度员工、Web 与飞书通知、复核阈值前后行为、回退，以及非管理员直连写接口拒绝。

- [ ] **Step 1: 补失败验收测试。** 覆盖产品方案第 8 节的灰度、复核、通知场景及权限。
- [ ] **Step 2: 验证 Red。** 在隔离环境运行相关 E2E/契约测试，记录预期失败。
- [ ] **Step 3: 完成联调手册。** 写明各环境配置发布、回退、兼容旧环境变量和异常时的安全处置。
- [ ] **Step 4: 验证 Green。** Go `go test ./... -count=1`、Web `npm test`/`npm run build`、根目录 `npm test -- tests/unit tests/contract`；现场灰度与飞书投递单独记录。
- [ ] **Step 5: Commit。** `test: verify admin operations configuration`
