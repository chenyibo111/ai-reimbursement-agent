# Admin Configuration Center Knowledge and AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有管理员配置中心管理政策来源的同步计划、知识检索参数，以及受控的票据分类模型和提示词版本，并用样本评估支持发布与回退。

**Architecture:** 延用基础阶段的不可变 Go 配置快照与内部只读接口；Node Agent 和政策同步 Worker 以服务身份读取已发布配置。飞书政策来源、文档快照和可执行报销政策保持现有独立存储。模型凭据和服务地址继续由运维注入，管理员只选择预先批准的运行档案。

**Tech Stack:** Go/PostgreSQL、Node/TypeScript/Prisma/Vitest、React/Vitest、现有飞书文档客户端、Embedding 服务与 Go 分类器。

**Spec:** `docs/admin-configuration-center-product-plan.md`（第 3–6 节、第三阶段与验收 7–8）。**Depends on:** `2026-11-12-admin-config-foundation.md` Tasks 1–5 与 `2026-11-12-admin-config-operations.md` Task 4 的 Node 配置读取客户端。

## Global Constraints

- 知识库只同步管理员显式授权的飞书 Docx/Wiki；同步失败保留最后一次成功的活动快照，不扫描其他空间。
- 检索配置只影响政策问答；`CATEGORY_ALLOWED` 等可执行规则只由现有 Go 政策版本页发布。没有足够引用时不让模型生成制度结论。
- 管理员不能输入任意模型 URL、API Key 或不受审查的系统提示词；这些与普通业务配置分离。模型档案和提示词版本必须先在代码/运维清单中批准。
- 高风险发布由不同 `ADMIN` 身份复核；问答样本评估未达门槛或配置读取失败不得自动降低引用要求。
- 每任务先失败测试、再实现、运行目标测试并单独 commit；Prisma 集成测试使用独立 `TEST_DATABASE_URL` 与 `npm run db:test:migrate`，不得连接日常业务库。

## Review Focus

- 定时同步与管理员手动同步同一来源同时发生：Task 1 的去重测试，只创建一个有效任务。
- 飞书文档部分读取失败：Task 1 的测试，旧活动快照保持可用。
- 降低检索门槛后命中不完整章节：Task 2 的测试，仍不输出没有完整依据的政策结论。
- Node 读取配置失败且没有缓存：Task 2 的测试，返回“无可引用政策”而非自行回答。
- 模型切换时旧请求仍在运行：Task 3 的测试，一张票据只用一个模型/提示词版本并保存版本标识。

---

## Task 1: 知识来源同步计划

**Files:**
- Create: `services/reimbursement-api/internal/application/knowledge_runtime_config.go`
- Test: `services/reimbursement-api/internal/application/knowledge_runtime_config_test.go`
- Create: `src/application/schedule-policy-source-sync.ts`
- Test: `tests/unit/application/schedule-policy-source-sync.test.ts`
- Modify: `src/worker/job-worker.ts`
- Modify: `src/infrastructure/prisma/async-job-repository.ts`
- Test: `tests/integration/policy-knowledge-repository.test.ts`
- Modify: `src/server/agent-admin-http.ts`
- Test: `tests/contract/reimbursement-routing.test.ts`
- Modify: `apps/web/src/routes/policy-sources-page.tsx`
- Test: `apps/web/src/routes/policy-sources-page.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `KnowledgeSyncConfig { Enabled bool; IntervalHours int; TimeZone string; SourceIDs []string }` 作为 Go `knowledge_runtime` 域的同步子配置；Node `schedulePolicySourceSync(now, config, sources, enqueue)` 按来源和计划时间槽生成稳定幂等键。管理员继续在现有政策来源页管理链接、启停和手动同步；配置中心只增加自动同步计划、最近成功快照与失败状态。计划时间使用明确时区，禁用来源不得排队。

- [ ] **Step 1: 写失败测试。** 手动/自动并发、同一时间槽重试、禁用来源、时区边界、文档读取失败时保留旧快照。
- [ ] **Step 2: 验证 Red。** 运行 Go `go test ./internal/application -run 'KnowledgeRuntimeConfig' -count=1`、根目录 `npm test -- tests/unit/application/schedule-policy-source-sync.test.ts tests/integration/policy-knowledge-repository.test.ts` 和 `apps/web` 的政策来源页测试。
- [ ] **Step 3: 实现。** 在现有 `POLICY_SOURCE_SYNC` 作业队列上增加计划触发和去重，不创建第二套同步服务；Go 配置发布后的内部只读快照由 Node 服务身份获取。
- [ ] **Step 4: 验证 Green。** 重跑目标测试；隔离环境模拟同步失败、恢复和重复调度。
- [ ] **Step 5: Commit。** `feat: schedule authorized policy source sync`

## Task 2: 知识检索参数与问答样本评估

**Files:**
- Modify: `services/reimbursement-api/internal/application/knowledge_runtime_config.go`
- Test: `services/reimbursement-api/internal/application/knowledge_runtime_config_test.go`
- Modify: `src/infrastructure/reimbursement/config-client.ts`
- Test: `tests/unit/infrastructure/config-client.test.ts`
- Modify: `src/application/search-policy-knowledge.ts`
- Test: `tests/unit/application/search-policy-knowledge.test.ts`
- Modify: `src/worker/feishu-bot.ts`
- Create: `src/application/evaluate-policy-retrieval-config.ts`
- Test: `tests/unit/application/evaluate-policy-retrieval-config.test.ts`
- Create: `apps/web/src/routes/admin-knowledge-config-page.tsx`
- Test: `apps/web/src/routes/admin-knowledge-config-page.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `KnowledgeRetrievalConfig { CandidateLimit: number; MinScore: number; CitationLimit: number }`，以当前 `12`、`0.65`、`3` 作为迁移默认值；`searchPolicyKnowledge(input, deps, config)` 从一次请求固定的配置快照读取这些值。`config-client.ts` 用受限服务凭据调用 Go `/internal/v1/config/{domain}/active`；返回版本及 payload，校验结构后缓存最后成功版本。管理员发布前在脱敏问答样本集上比较有引用率、无引用率和误引用样例；不完整章节仍不能作为可靠证据。

- [ ] **Step 1: 写失败测试。** 默认参数等价于旧行为、门槛升降后的引用变化、配置读取失败/畸形 JSON、不完整章节、零命中时不编造制度结论。
- [ ] **Step 2: 验证 Red。** 运行 Go `go test ./internal/application -run 'KnowledgeRuntimeConfig' -count=1` 与根目录 `npm test -- tests/unit/application/search-policy-knowledge.test.ts tests/unit/application/evaluate-policy-retrieval-config.test.ts tests/unit/infrastructure/config-client.test.ts`。
- [ ] **Step 3: 实现。** 将当前 `12`、`0.65`、`3` 作为首次发布的基线快照并限制调整范围；每次问答锁定一个已发布配置版本并在审计中关联版本；管理员页先展示样本差异再允许高风险发布。读取失败且进程中没有有效快照时不返回引用，不以空配置放宽门槛。
- [ ] **Step 4: 验证 Green。** 重跑目标测试、Agent 工作流回放和根目录 `npm run lint`；确认可执行政策结果未变化。
- [ ] **Step 5: Commit。** `feat: evaluate and configure policy retrieval`

## Task 3: 受控分类模型与提示词版本

**Files:**
- Create: `services/reimbursement-api/internal/application/classifier_profile.go`
- Test: `services/reimbursement-api/internal/application/classifier_profile_test.go`
- Modify: `services/reimbursement-api/internal/infrastructure/receipt_classifier.go`
- Test: `services/reimbursement-api/internal/infrastructure/receipt_classifier_test.go`
- Modify: `services/reimbursement-api/internal/application/receipt_service.go`
- Modify: `services/reimbursement-api/internal/domain/expense_item.go`
- Modify: `services/reimbursement-api/cmd/worker/main.go`
- Create: `apps/web/src/routes/admin-model-config-page.tsx`
- Test: `apps/web/src/routes/admin-model-config-page.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Interfaces:** `ModelRuntimeConfig { ApprovedProfileID, PromptVersion string }`；Go `ClassifierProfileRegistry` 从运维环境装入获准模型名称/地址/密钥引用，管理员只能选 ID，不能提交任意 URL 或密钥。提示词版本由代码注册并具备输入/输出契约；单次 OCR 请求固定 `modelRuntimeVersion`，费用明细保留分类模型与提示词版本。配置发布前用脱敏打车、餐饮、住宿、交通、其他和未知票样本验证分类正确率、证据合规率、空值率与超时。

- [ ] **Step 1: 写失败测试。** 未批准 profile/提示词版本拒绝发布、模型返回虚构金额被忽略、超时保留 OCR 事实、配置切换并发时版本不混用、密钥不进入 Web 响应/日志。
- [ ] **Step 2: 验证 Red。** 在 Go 模块运行 `go test ./internal/application ./internal/infrastructure -run 'ClassifierProfile|ReceiptClassifier' -count=1`，在 Web 运行目标页面测试。
- [ ] **Step 3: 实现。** 选择获准档案并保留现有证据校验与 JSON 解析；模型/提示词切换不重算既有票据，必要时由授权人员显式重算并预览差异。
- [ ] **Step 4: 验证 Green。** 重跑目标测试和分类样本评估；对比旧版本指标，出现明显退化不得发布。
- [ ] **Step 5: Commit。** `feat: manage approved receipt classifier profiles`

## Task 4: 配置中心整体验收与交付

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/architecture.md`
- Test: `tests/contract/reimbursement-routing.test.ts`
- Test: `tests/integration/policy-knowledge-repository.test.ts`
- Test: `services/reimbursement-api/internal/store/postgres_config_repository_test.go`

**Interfaces:** 管理员从同一配置中心访问业务字典、智能补单、灰度、复核、通知、知识/AI，以及现有政策规则和知识来源；所有配置页显示当前版本、生效状态、审计和回退入口。配置快照与单据、识别结果、通知和知识问答关联，支持按版本追溯。

- [ ] **Step 1: 补失败验收测试。** 覆盖管理员权限、跨环境隔离、各域版本回退、知识同步失败、政策与知识独立、旧单据历史快照。
- [ ] **Step 2: 验证 Red。** 在隔离环境运行目标契约和集成测试，记录缺口。
- [ ] **Step 3: 完成联调与运行手册。** 标出依赖的 Go/Prisma 迁移顺序、批准模型档案、密钥管理、故障回退、日志与指标查询。
- [ ] **Step 4: 验证 Green。** Go `go test ./... -count=1`；Web `npm test`、`npx tsc --noEmit`、`npm run build`；根目录 `npm test` 与 `npm run lint`。飞书真实文档授权、真实模型与两个测试员工链路单独现场验收。
- [ ] **Step 5: Commit。** `test: verify admin configuration center end to end`
