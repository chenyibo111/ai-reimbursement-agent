# Receipt-Driven Itemized Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web 和飞书上传票据后，在同一草稿内按票据生成可编辑的费用明细，自动分类并汇总，Agent 与 Web 读取同一份 Go 数据。

**Architecture:** Go 报销 API 是票据、明细、政策校验和提交快照的唯一写入方。OCR 先提供票面事实，受控模型仅提出类别与通用事由建议；服务端校验并幂等写入草稿，手工编辑优先。分阶段交付，旧单据与接口在迁移期保留兼容路径。

**Tech Stack:** Go、PostgreSQL 迁移、React/TypeScript/Vitest、Node Agent、OpenAI-compatible chat endpoint、现有 OCR 服务。

**Spec:** `docs/superpowers/specs/2026-11-09-receipt-driven-itemized-claim-design.md`

## Global Constraints

- 一张票据对应一条明细，混合类别保留在一张草稿；整单金额默认加总有效明细的当前金额。
- OCR 无法支持的项目编码、同行人和业务目的留空；通用事由可以按类型预填，模型不能编造金额。
- 新明细草稿的旧整单类别/项目/同行人 PATCH 应拒绝；无明细旧草稿保留原写入路径。
- Web 和飞书上传共用服务端链路；只允许本人读取和修改草稿，保持版本检查、审计、幂等及显式提交确认。
- 用户手工编辑不被 OCR/模型重试覆盖；OCR 低置信、重复和复核中的票据不能绕过现有提交阻断。
- 现有政策检索门槛不变；结构化政策按明细类别校验。
- 当前任务不自动 commit、push 或部署；执行者仅在用户另行授权后提交。

## Review Focus

- 两个 OCR 事件同时处理同一草稿时，产生两条明细且整单合计准确：Task 2 的并发仓储测试。
- 用户改了类别后 OCR 事件重放，保留人工类别：Task 2 的重放测试。
- 一张票据金额缺失，模型返回虚构金额时，明细金额仍为空：Task 5 的解析测试。
- 混合类别中只有餐饮需要项目编码时，错误定位餐饮明细：Task 3 的政策测试。
- 员工甲用员工乙的明细 ID 更新时，不透露明细是否存在：Task 4 的 HTTP 授权测试。

---

## Stage 1: 明细基础与 Web 核对

### Task 1: 持久化一票一明细并兼容旧单

**Files:**
- Create: `services/reimbursement-api/db/migrations/000019_expense_items.sql`
- Create: `services/reimbursement-api/internal/domain/expense_item.go`
- Create: `services/reimbursement-api/internal/store/expense_item_repository.go`
- Test: `services/reimbursement-api/internal/store/postgres_expense_item_repository_test.go`
- Modify: `services/reimbursement-api/internal/domain/claim.go`

**Interfaces:** `ExpenseItem` 含 `ClaimID`、`ReceiptID`、`ReceiptType`、`ExpenseCategory`、`Purpose`、`AmountCent *int64`、`AmountSource`、`CategorySource`、`PurposeSource`、`ProjectCode`、`Participants`；`ExpenseItemSuggestion` 包含 OCR 金额及可为空的类型/类别/通用事由，`ExpenseItemPatch` 包含用户可修改的明细字段。仓储提供 `UpsertFromOCR(ctx, actorID, receiptID, suggestion ExpenseItemSuggestion) (ExpenseItem, error)`、`ListOwnedByClaim(ctx, actorID, claimID) ([]ExpenseItem, error)`、`PatchOwnedDraft(ctx, actorID, claimID, itemID, expectedClaimVersion, patch ExpenseItemPatch) (ExpenseItem, error)`。唯一约束为 `receipt_id`，写入须增加整单版本并写审计/outbox。为 claim 增加持久化的 `LEGACY`/`ITEMIZED` 模式，过渡期按模式选择读写和校验，不用“是否已有明细”推断模式；旧已提交单据不回填。旧草稿仅在明确转换为 `ITEMIZED` 时依据已存 OCR 事实建立金额明细，未知类型/类别/事由为空。

- [ ] 写仓储失败测试：同 receipt 重放只得一条、跨员工访问无权、人工来源字段不被 OCR 覆盖、旧草稿回填不猜类别。
- [ ] 运行 `go test ./internal/store ./internal/domain`（workdir `services/reimbursement-api`），确认新增测试因缺实现失败。
- [ ] 实现迁移、领域类型、仓储操作与旧草稿兼容回填；对同一 claim 的汇总更新使用数据库事务和版本保护。
- [ ] 重跑上述测试；再跑 `go test ./internal/store ./internal/domain`，确认通过。

### Task 2: OCR 金额生成明细与整单汇总

**Files:**
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion.go`
- Modify: `services/reimbursement-api/internal/store/claim_repository.go`
- Modify: `services/reimbursement-api/internal/application/claim_service.go`
- Modify: `services/reimbursement-api/cmd/api/main.go`
- Test: `services/reimbursement-api/internal/application/refresh_claim_ocr_suggestion_test.go`
- Test: `services/reimbursement-api/internal/store/postgres_claim_repository_test.go`

**Interfaces:** OCR 成功后对 `ITEMIZED` claim 调用 Task 1 的 `UpsertFromOCR`；整单 OCR 建议金额由有效明细的当前 `AmountCent` 求和；`MANUAL` 整单金额保持不动。删除票据时删除关联明细并重算；复核状态票据不进入有效合计。API 通过 `REIMBURSEMENT_ITEMIZED_EMPLOYEE_IDS` 员工 allowlist 为新草稿选择持久化模式；空值时仍创建 `LEGACY` 草稿。

- [ ] 写失败测试：双票据并发/重放、单条手工金额后重算、删除票据、`MANUAL` 整单金额不被覆盖。
- [ ] 运行 `go test ./internal/application ./internal/store`，确认目标测试按预期失败。
- [ ] 将 OCR、明细和整单汇总连成幂等事务；保留原有复核/重复票阻断。
- [ ] 重跑目标包测试，确认通过。

### Task 3: 逐条政策、确认与提交快照

**Files:**
- Modify: `services/reimbursement-api/internal/application/policy_rules.go`
- Modify: `services/reimbursement-api/internal/application/submission_service.go`
- Modify: `services/reimbursement-api/internal/store/submission_repository.go`
- Test: `services/reimbursement-api/internal/application/policy_rules_test.go`
- Test: `services/reimbursement-api/internal/application/submission_test.go`
- Test: `services/reimbursement-api/internal/store/postgres_policy_submission_test.go`

**Interfaces:** `EvaluatePolicyRules(version, claim, items)` 对每条有效明细执行 `CATEGORY_ALLOWED`/`CATEGORY_REQUIRED_FIELD`，`CLAIM_TOTAL_MAX` 仍按整单申请金额；无明细旧单走旧规则。验证问题携带 `itemId`/`receiptId` 供 UI 定位。任何明细变动使旧确认版本失效；提交快照保存明细。

- [ ] 写失败测试：打车加餐饮两条不同类别、只在餐饮明细要求项目编码、旧单规则兼容、改明细后确认失效、快照内容。
- [ ] 运行 `go test ./internal/application ./internal/store`，确认失败原因是尚未支持逐条校验。
- [ ] 实现逐条规则、提交输入加载和快照；手工整单金额与明细合计不等时展示差额但不新增阻断。
- [ ] 重跑目标包测试，确认通过。

### Task 4: Go API 与 Web 明细编辑

**Files:**
- Modify: `services/reimbursement-api/internal/transport/http/router.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler.go`
- Test: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `api/openapi/reimbursement-v1.yaml`
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/features/claims/claim-application-form.tsx`
- Test: `apps/web/src/features/claims/claim-application-form.test.tsx`
- Modify: `apps/web/src/routes/claim-workbench-page.tsx`

**Interfaces:** claim GET 返回 `expenseItems`、`expenseCategories`、有效明细合计；`PATCH /api/v1/claims/{claimId}/items/{itemId}` 使用整单 `version` 和本人身份更新单条明细。旧 `PATCH /claims/{id}` 对新明细单的类别/项目/同行人返回可操作的冲突错误，事由/总额/备注仍可编辑。Web 逐条展示来源和缺失字段，编辑后回读 Go，汇总与差额同步刷新。

- [ ] 写失败测试：混合类别返回形状、逐条编辑/版本冲突/越权、旧 PATCH 拒绝；Web 展示两票两类及手工纠错。
- [ ] 运行 `go test ./internal/transport/http` 与 `npm --prefix apps/web test -- claim-application-form.test.tsx`，确认目标失败。
- [ ] 实现 API、OpenAPI 类型与 Web 表单；复用现有票据预览和草稿保存状态。
- [ ] 重跑目标测试、`npm --prefix apps/web run build`；对 Web 上传两票做人工验收。阶段 1 完成前保持新链路发布开关关闭。

## Stage 2: 智能分类与自动预填

### Task 5: OCR 文本与受控结构化分类

**Files:**
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/infrastructure/ocr_client.go`
- Modify: `services/reimbursement-api/internal/infrastructure/ocr_parser.go`
- Create: `services/reimbursement-api/db/migrations/000020_receipt_ocr_text.sql`
- Modify: `services/reimbursement-api/internal/store/receipt_repository.go`
- Create: `services/reimbursement-api/internal/application/receipt_classification.go`
- Create: `services/reimbursement-api/internal/infrastructure/receipt_classifier.go`
- Test: `services/reimbursement-api/internal/infrastructure/receipt_classifier_test.go`
- Test: `services/reimbursement-api/internal/infrastructure/ocr_client_test.go`

**Interfaces:** `ReceiptClassifier.Classify(ctx, OCRFacts, allowedCategories) (ClassificationSuggestion, error)` 返回受控票据类型、标准费用类别、通用事由、证据和版本；未知返回空字段。原始 OCR 金额是唯一自动金额来源，模型输出金额一律忽略。限定输入长度、输出结构、超时和日志字段；在 Go worker 中使用现有 OpenAI-compatible 服务的配置值，不添加新依赖。OCR 文本使用受限数据库列保存，仅供本人授权下的内部分类重试，不进入公开票据响应。

- [ ] 写失败测试：打车/餐饮/住宿/交通、未知票据、提示注入文字、模型虚构金额、超时/非法 JSON/未允许类别。
- [ ] 运行 `go test ./internal/infrastructure ./internal/application`，确认目标失败。
- [ ] 扩展 OCR 结果并实现分类器和服务端类别映射；失败时返回未知建议，不阻断票据事实保存。
- [ ] 重跑目标包测试，确认通过；用脱敏样本记录分类准确率和人工纠正率基线。

### Task 6: 统一上传后的自动补单

**Files:**
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/workers/application_receipt_extractor.go`
- Modify: `services/reimbursement-api/cmd/worker/main.go`
- Test: `services/reimbursement-api/internal/application/extract_receipt_test.go`
- Test: `services/reimbursement-api/internal/workers/application_receipt_extractor_test.go`
- Test: `apps/web/src/features/receipts/use-receipt-upload.test.tsx`

**Interfaces:** 同一 Go OCR 完成事件触发 Task 5 分类并调用 Task 1 的 `UpsertFromOCR`，不按上传渠道分叉；自动来源的整单事由在用户未修改时按明细概括。模型失败/低置信/重复事件有明确状态；Web 查询或事件刷新后看到同一草稿。

- [ ] 写失败测试：Web/飞书来源得到同样明细、重复事件无重复项、人工字段不覆盖、模型失败仍保留 OCR 金额。
- [ ] 运行相关 Go 包和 Web 上传测试，确认目标失败。
- [ ] 接入分类、持久化、汇总及异步通知事件；发布开关默认关闭，按测试员工逐步开启。
- [ ] 重跑相关测试，执行 Go 构建与 Web 构建，并使用脱敏混合票据走一次 Web 上传到提交确认的集成验收。

## Stage 3: Agent 对话补单

### Task 7: Agent 明细读取、指定修改与通知

**Files:**
- Modify: `services/agent/src/ports/reimbursement-port.ts`
- Modify: `services/agent/src/tool-gateway/reimbursement-tools.ts`
- Modify: `services/agent/src/tool-gateway/conversation-reimbursement.ts`
- Modify: `src/application/run-conversation-turn.ts`
- Modify: `src/application/format-receipt-extraction-notification.ts`
- Modify: `src/application/evaluate-agent-workflow.ts`
- Test: `services/agent/src/tool-gateway/reimbursement-tools.test.ts`
- Test: `services/agent/src/tool-gateway/conversation-reimbursement.test.ts`
- Test: `src/application/run-conversation-turn.test.ts`

**Interfaces:** `getClaimWorkbench` 返回 Go 明细与汇总；新增 `updateExpenseItem(input: ToolCallContext & { claimId: string; itemId: string; version: number; fields: ExpenseItemPatch }): Promise<ClaimSnapshot>`。模型只能提出字段提案，服务端从本人草稿及明确票据目标中解析 `itemId`；多个候选时追问，不猜目标。写后回读成功才回复“已保存”。

- [ ] 写失败测试：两票分类摘要、指定票据纠错、模糊指代追问、群聊无个人信息、越权/版本冲突、通知不宣称模型建议为已确认事实。
- [ ] 运行 `npm --prefix services/agent test` 与目标根目录 Vitest 用例，确认预期失败。
- [ ] 扩展受控 Go 工具网关与对话编排；保留现有审计、幂等、提交确认和私聊边界。
- [ ] 重跑相关测试、`npm run eval:agent`，再用两名测试员工验证飞书与 Web 一致。

## Stage 4: 灰度与验收

- [ ] 先在测试环境迁移并启用少量员工，核对旧草稿、旧提交记录、票据复核、混合票据及提交快照。
- [ ] 观察分类错误、人工纠正、OCR/模型失败、重复事件和政策阻断；仅在指标与人工样本验收达标后扩大启用范围。
- [ ] 回退时关闭新链路发布开关，保留新增明细和历史提交快照；不得以清理数据作为回退步骤。

## Self-review

上述任务覆盖设计的持久化、OCR/模型、Web、Agent、政策、提交和灰度边界。实施前核对实际 Go 工具链与测试数据库可用性；若本机缺 Go，使用仓库现有容器构建/测试环境执行相同测试，不把“未运行”写成“通过”。计划文档本身不授权 commit、push 或部署。
