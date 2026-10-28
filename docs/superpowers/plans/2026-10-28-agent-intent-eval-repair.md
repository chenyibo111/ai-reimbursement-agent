# Agent Intent Eval Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复删除票据意图的单号契约和评测误计数，并复测真实模型。

**Architecture:** 模型输出仍由 Zod 限制；业务动作由 `runConversationTurn` 对已选草稿核验，并通过现有待确认流程执行。评测器分别报告分类、参数、目标和安全失败。

**Tech Stack:** TypeScript, Vitest, OpenAI-compatible model API.

**Spec:** `docs/superpowers/specs/2026-10-28-agent-intent-eval-repair.md`

## Global Constraints

- 不修改 `tests/fixtures/intent-eval/holdout-v3.jsonl` 的样本或答案。
- 不放宽删除票据的本人草稿、指定票据、独立确认和版本校验。
- 不新增关键词路由。

## Review Focus

- 模型返回单号与已选草稿不同：必须拒绝生成待确认操作。
- 模型返回正确单号及序号：只生成待确认操作，不能直接删除。
- 缺票据序号：列出当前票据并要求指定。
- 安全澄清或格式拒绝：不能当成选错具体目标。
- 错误的具体报销单号或票据序号：仍计入目标引用错误。

---

### Task 1: 删除票据单号核验

**Files:** `src/infrastructure/model/openai-compatible-chat-model.ts`, `src/application/run-conversation-turn.ts`, `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`, `tests/unit/application/run-conversation-turn.test.ts`

- [x] 新增模型可返回 `DELETE_RECEIPT` 单号和序号的失败测试。
- [x] 新增相同、冲突单号下待确认操作与零直接删除的失败测试。
- [x] 运行定点测试确认失败，再允许受限单号并在服务端核对已选草稿及用户原句中的显式单号。
- [x] 运行定点测试确认通过。

### Task 2: 评测口径与意图边界

**Files:** `src/application/evaluate-intent.ts`, `src/infrastructure/model/openai-compatible-chat-model.ts`, `tests/unit/application/evaluate-intent.test.ts`, `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`, `docs/operations/agent-intent-evaluation.md`

- [x] 新增安全澄清与错误目标分别计数的失败测试；真实模型原始失败样本用作提示词边界诊断。
- [x] 运行定点测试确认失败，再修改目标引用指标与提示词。
- [x] 运行定点测试确认通过，并更新指标说明；增加一次格式失败受限重试及失败测试。

### Task 3: 验证

- [x] 运行 `npx tsc --noEmit`、`npm test` 和适用构建检查。
- [x] 运行真实模型 `dev-v3` 与完整 `holdout-v3`，报告分数、失败样本 ID、门槛和波动；不改保留集。
- [x] 检查 `git diff` 和 `git status`，报告剩余风险。

## 验证记录

- `dev-v3` 第二轮（`semantic-intent-v3`）：89 条，宏 F1 0.968，参数准确率 0.933，格式失败 0；误判 `d-q04`、`d3-delete-draft-03`。
- `holdout-v3` 两轮：85 条，宏 F1 0.992 / 0.982，参数准确率均为 1，格式失败、危险提交误判、错误写入目标和目标引用错误均为 0；两轮门槛均通过。第二轮误判 `h-h04`，说明模型仍有波动。
- `npm test`：112 个测试文件、501 项通过。`npm run build` 和 `npx tsc --noEmit` 通过；`npm run lint` 无错误，保留 React 页面原有的两条 Hook 依赖警告。
