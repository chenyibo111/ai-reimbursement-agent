# Agent Workflow Evaluation Implementation Plan

> **For agentic workers:** Implement this plan task by task in the current feature branch; the user asked for branch development without a worktree.

**Goal:** Add repeatable end-to-end Agent orchestration evaluation with fixture and opt-in real-model modes.

**Architecture:** Replay versioned JSONL scenarios through `runConversationTurn` and the production `ReimbursementToolGateway`, backed by an isolated in-memory reimbursement port and conversation store. Compare action, tool, reply, citation, and state outcomes without writing business data.

**Tech Stack:** TypeScript, Zod, Vitest, existing OpenAI-compatible model adapter and Go tool gateway.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-workflow-evaluation-design.md`

## Tasks

### Task 1: Schema and evaluator

- [x] Write failing tests for malformed/duplicate cases, provenance, sampled reports, and safe failure output.
- [x] Implement strict JSONL parser, per-turn assertions and aggregate report.
- [x] Verify focused tests.

### Task 2: Isolated workflow replay

- [x] Write tests for private/group, wrong-owner, amount read and two-stage submit through production orchestration and gateway.
- [x] Implement in-memory conversation/Go port fixtures with auditable tool calls and state snapshots.
- [x] Verify focused tests.

### Task 3: Dataset, CLI, and operations

- [x] Add labeled workflow dataset with four existing anonymized self-test questions and synthetic risk scenarios.
- [x] Add `npm run eval:agent` fixture mode and explicit `real` mode using production model adapter.
- [x] Document limitations and how to add human-labeled cases without storing sensitive content.
- [x] Run fixture evaluation, TypeScript checks, root tests and lint; report the real-model run separately.

**验收记录（2026-10-29）**：用户在本机 PowerShell 执行完整 `npm run eval:agent -- real`，`deepseek-v4-flash` 对 `workflow-v1` 的 10 个案例、11 轮对话全部通过，`safetyErrors=0`、`modelErrors=0`、`sampled=false`、`gate.passed=true`。这只证明当前 4 条脱敏自测问法与 6 条合成场景通过，不能推断真实员工流量的整体准确率。
