# Semantic Intent Routing and Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以单次模型结构化意图路由替代主会话的关键词抢先判定，并建立真实模型的离线意图评测。

**Architecture:** 飞书私聊与 Web 私有会话共用 `runConversationTurn`。模型只分类动作并建议获准字段；服务端守卫 Intake 状态和渠道，Go 是单据事实与提交权限的权威。政策检索仅在分类为 `POLICY_QUERY` 后发生；最终提交保留准确回复 `确认提交` 与 Go 令牌双重门槛。

**Tech Stack:** TypeScript、Vitest、Zod、Prisma/PostgreSQL、现有 OpenAI-compatible Chat Completions 和 Go 工具网关。

**Spec:** `docs/superpowers/specs/2026-10-24-semantic-intent-routing-and-evals-design.md`

## Global Constraints

- 普通文本只走一次结构化模型判定；不能用正则、关键词或旧 `classifyIntent` 兜底。
- 准确的 `确认提交` 是唯一绕过普通文本分类的提交命令；附件保留既有安全流程。
- 模型输出不可信任为金额、身份、单据 ID、确认令牌或财务结论；权限、校验和提交仍由 Go 决定。
- 模型不可用或响应无效时安全澄清，不能执行写操作；群聊不得泄露单据事实。
- 只改 Web 私有会话/飞书主路径；旧单据绑定 `/api/claims/[claimId]/chat` 保持兼容。
- 在现有 `feature/semantic-intent-routing-evals` 分支开发，不创建 worktree；评测数据只能匿名或合成，真实模型评测显式运行。

## Review Focus

- 否定提交、条件提交不能误准备提交：Task 3 路由测试、Task 4 危险样本。
- “本单住宿是否超标准”不能因关键词误进政策问答：Task 3 检索调用测试、Task 4 混淆统计。
- 进行中的 Intake 不能被一次“新建”悄然废弃：Task 2 原子性/过期测试、Task 3 二次请求测试。
- 伪造金额、ID、越权字段不能写入或输出：Task 1 解析测试、Task 3 回复测试。
- 飞书重投消息不能产生重复创建或重复提交：Task 3 幂等回归测试。

## File Structure

- `src/infrastructure/model/chat-model.ts` 定义统一动作；`openai-compatible-chat-model.ts` 负责提示词和严格解析；`fake-chat-model.ts` 仅作测试 fixture。
- `src/application/run-conversation-turn.ts` 负责单一路由、状态守卫和派发；`build-conversation-context.ts` 提供有界历史，不提前注入政策片段。
- `prisma/schema.prisma`、新 migration、`src/infrastructure/prisma/agent-conversation-repository.ts` 持久化并原子消费重开请求。
- `src/application/evaluate-intent.ts`、`scripts/eval-intent.ts`、`tests/fixtures/intent-eval/*.jsonl` 承担纯分类评测；`README.md` 说明运行和人工验收。

### Task 1: 统一动作契约与严格解析

**Files:** Modify `src/infrastructure/model/chat-model.ts`, `src/infrastructure/model/openai-compatible-chat-model.ts`, `src/infrastructure/model/fake-chat-model.ts`; test `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`, `tests/unit/infrastructure/fake-chat-model.test.ts`.

**Interfaces:** Produce `ConversationAction = "POLICY_QUERY" | "START_INTAKE" | "COLLECT_FIELDS" | "READ_CLAIM" | "READ_RECEIPT_AMOUNT" | "READ_SUBMISSION_SUMMARY" | "PREPARE_SUBMISSION" | "HELP" | "CLARIFY" | "OUT_OF_SCOPE"`. `ConversationDecision` has `action`, existing wire-compatible `reply`, optional allowlisted `fields` (only for `COLLECT_FIELDS`), and optional `clarificationReason: "POLICY_OR_CLAIM" | "START_OR_HELP" | "MULTIPLE_ACTIONS" | "UNCLEAR_REFERENCE" | "OTHER"` (only for `CLARIFY`). Consume existing `ConversationContext`; leave legacy `classifyIntent` for the old route.

- [x] **Step 1: Write failing tests.** Assert all new actions parse; unknown action/key, fields on non-collect, out-of-allowlist fields and misplaced reason reject with `INVALID_RESPONSE`. Assert prompt distinguishes negation, mixed intent and policy-versus-current-claim; request body excludes claim ID, secret and pre-retrieved policy content.
- [x] **Step 2: Run** `npx vitest run tests/unit/infrastructure/openai-compatible-chat-model.test.ts tests/unit/infrastructure/fake-chat-model.test.ts`; expect the new cases RED for missing contract.
- [x] **Step 3: Implement** the action union, Zod schema, prompt and deterministic fixture contract. Retain `reply` for wire compatibility but do not treat it as authoritative output.
- [x] **Step 4: Run** both test files and `npx tsc --noEmit`; expect PASS. Commit this task and its tests.

### Task 2: 持久化活动 Intake 的重开请求

**Files:** Modify `prisma/schema.prisma`, `src/infrastructure/prisma/agent-conversation-repository.ts`; create `prisma/migrations/20261025010000_intake_restart_request/migration.sql`; test `tests/integration/agent-conversation-repository.test.ts`.

**Interfaces:** Produce nullable `restartRequestedAt: Date | null`, `updateIntake({ id, restartRequestedAt })`, and `restartIntake({ employeeId, conversationId, intakeId, requestedAfter: Date }): Promise<ReimbursementIntake>`. The repository transaction checks a matching active Intake and non-expired request, marks it `ABANDONED`, clears submission token/preview, then creates a fresh `COLLECTING` Intake with `pendingFields: ["purpose"]`. Failure rolls back the abandon.

- [x] **Step 1: Write failing integration tests** for persisted request, successful restart, expired/foreign request rejection, duplicate replay and rollback if replacement creation fails.
- [x] **Step 2: Run** `npx vitest run tests/integration/agent-conversation-repository.test.ts`; expect RED because fields/method do not exist.
- [x] **Step 3: Implement** schema, migration and one Prisma transaction, retaining the existing partial unique active-Intake index. Regenerate Prisma client with the repository's Prisma 7 config.
- [x] **Step 4: Apply test migration; run** the integration file and `npx tsc --noEmit`; expect PASS. Commit this task without manually changing production data.

### Task 3: 主会话单一路由与安全派发

**Files:** Modify `src/application/run-conversation-turn.ts` and, if needed, `src/application/build-conversation-context.ts`; test `tests/unit/application/run-conversation-turn.test.ts`, `tests/integration/conversation-intake-flow.test.ts`, `tests/integration/cross-channel-conversation.test.ts`.

**Interfaces:** Consume `ConversationDecision` from Task 1 and `restartRequestedAt`/`restartIntake` from Task 2. Extend `ConversationStore` accordingly. Extend `ConversationContext.intake` with server-derived `restartPending: boolean`, so the model can interpret an affirmative reply in that context; never expose the timestamp itself. Produce `runConversationTurn` with one `decideConversation(context)` call per ordinary text turn; no preclassification policy search.

- [x] **Step 1: Write/adjust failing tests.** Cover `POLICY_QUERY` search-after-classification; current-claim question routed to Go without search; model `START_INTAKE`; first active-Intake start request only setting `restartRequestedAt`; second explicit start within 10 minutes atomically restarting; expired or unrelated response clearing the pending request; `HELP`/`CLARIFY`/`OUT_OF_SCOPE` server templates; fabricated model facts ignored; timeout/invalid decision safe guidance without writes. Test that group `START_INTAKE`/`COLLECT_FIELDS`/reads/submission are blocked before state change or Go call. Preserve exact-confirmation, attachment and dedup tests. Replace old tests that expect immediate abandon or legacy `ANSWER`.
- [x] **Step 2: Run** the three targeted test files; expect RED on old keyword/route behavior.
- [x] **Step 3: Implement** one model decision, catch model failure safely, search only for `POLICY_QUERY`, dispatch `START_INTAKE` under Task 2 state rule, and use server-owned replies for non-factual actions. Keep Go reads/validation/token, field allowlist and group guards unchanged; remove `classifyIntent` from this main path.
- [x] **Step 4: Run** targeted files, `npx tsc --noEmit`, `npm test`; expect PASS. Record any unrelated failures by name, then commit.

### Task 4: 纯分类离线评测与数据集

**Files:** Create `src/application/evaluate-intent.ts`, `scripts/eval-intent.ts`, `tests/fixtures/intent-eval/dev.jsonl`, `tests/fixtures/intent-eval/holdout.jsonl`, `tests/unit/application/evaluate-intent.test.ts`, `tests/unit/infrastructure/intent-eval-cli.test.ts`; modify `package.json`.

**Interfaces:** Produce `evaluateIntent(cases, decide): Promise<IntentEvalReport>` including per-action precision/recall/F1, macro F1, confusion matrix, out-of-scope recall, dangerous `PREPARE_SUBMISSION` false positives, clarification rate, latency and typed failures. Each JSONL case contains `id`, `message`, bounded `history`, `intakeStatus`, `channel`, `expectedAction`, optional `acceptedActions` and risk tags. `npm run eval:intent` only invokes `decideConversation`, not Go/policy/repository; outputs model/prompt/dataset versions without secrets or personal text.

- [ ] **Step 1: Write failing metrics/schema/CLI tests.** Use a small synthetic confusion matrix with exact expected metrics. Verify malformed cases fail, provider `fixture` is refused for real-model run, and runner has no Go/policy/write dependency.
- [ ] **Step 2: Run** both new test files; expect RED for missing evaluator/CLI.
- [ ] **Step 3: Implement** pure evaluator, CLI and ~120 diverse synthetic/anonymized dev/locked-holdout cases covering all actions, synonyms, negation, policy/current-claim boundary, absent Intake, group, mixed intent and prompt injection. Real-model invocation is opt-in; never claim fixture results demonstrate semantic quality.
- [ ] **Step 4: Run** metric tests, dataset validation, `npx tsc --noEmit`, `npm test`; expect PASS. Run real-model baseline only if provider is configured, otherwise record `not run`. Commit data, script and tests.

### Task 5: 跨渠道验收与维护说明

**Files:** Modify `README.md`; modify `tests/unit/application/process-feishu-event.test.ts` or `tests/integration/api/conversation-routes.test.ts` for parity coverage; update this plan's checkboxes.

**Interfaces:** Consume Tasks 1–4; no new runtime API.

- [ ] **Step 1: Write failing cross-channel regression test** for matching private Web/Feishu policy and claim-read actions, group read rejection, and exact-only final submission.
- [ ] **Step 2: Run** affected file; expect RED if channel behavior differs.
- [ ] **Step 3: Make only the necessary wiring fix,** if any. Document evaluation command, real-model versus fixture semantics, proposed gates (macro F1 ≥ 0.90, out-of-scope recall ≥ 0.90, zero unsafe submit negatives) and manual acceptance in `README.md`.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and relevant Go tests if Go changed; report exact outcomes, then commit. Do not push or merge without user direction.

## Self-Review

Each spec requirement has an owning task: contract (1), persistent safe restart (2), no-keyword routing/policy-on-demand/Go boundaries (3), real-model evaluation (4), channel parity/documentation (5). Shared types and methods are produced before consumers. All five Review Focus risks map to a named test step. The legacy claim-bound route remains outside scope.
