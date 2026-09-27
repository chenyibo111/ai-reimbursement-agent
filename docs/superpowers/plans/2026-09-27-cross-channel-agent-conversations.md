# 跨渠道报销 Agent 会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供独立于报销单的员工跨渠道会话，并通过受控 Intake 在对话中办理、确认并提交报销单。

**Architecture:** `AgentConversation` 与 `AgentMessage` 保存跨渠道私有历史和群聊隔离历史；`ReimbursementIntake` 保存一次短期报销办理的权威状态。新的 `runConversationTurn` 只读入摘要、最近窗口、Intake 和即时 RAG 片段，所有草稿、附件、字段与提交写入仍复用现有受控应用用例。

**Tech Stack:** Next.js 15、React 19、TypeScript、Prisma 7/PostgreSQL、pgvector、MinIO/S3、PaddleOCR、`@larksuiteoapi/node-sdk`、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-27-cross-channel-agent-conversation-design.md`

## Global Constraints

- 在 `master` 直接开发；不创建 Git worktree。
- Web 私有会话与飞书单聊共享员工私有会话；飞书群聊始终以 `employeeId + chatId` 隔离。
- 会话不以 `claimId` 为主归属；草稿删除不删除独立会话，员工删除时级联删除会话、消息和 Intake。
- 政策问答不得创建草稿或 Intake；首次“开始报销”或合规票据上传才创建 Intake。
- 模型只能提出受白名单约束的字段建议；草稿、附件、字段与提交写入必须调用既有服务端用例。
- 仅精确“确认提交”可触发当前有效 Intake 的提交，且服务端必须重新校验归属、版本、票据与政策规则。
- 不持久化飞书 token、附件字节、对象键、完整 OCR 原文、原始飞书事件包或模型内部提示词。
- 新增 UI 复用 `DESIGN.md` 与 `UX-CONTRACT.md` 的既有 token、按钮、状态与可访问性规范。

## Review Focus

- 同一飞书 `messageId` 重试时，用户消息、Agent 回复、草稿与提交都只能写入一次；Task 1 和 Task 5 覆盖。
- 飞书群聊内容不能通过私有 Web 会话、摘要或 API 读出；Task 1、Task 4 和 Task 6 覆盖。
- 超长历史压缩后，提交/金额/票据等业务事实必须仍从 Intake 和 ClaimDraft 读取；Task 2 覆盖。
- “确认提交”在已提交、过期、无 Intake 或校验失败时不得再次提交；Task 3 覆盖。
- 手动创建的 Web 草稿不得被悬浮 Agent 自动选中或修改；Task 3 与 Task 6 覆盖。

---

## File Structure

- `prisma/schema.prisma` 和新迁移：定义会话、消息和 Intake 的最小数据关系、唯一约束及级联规则。
- `src/domain/agent-conversation.ts`：会话范围、角色、渠道、办理状态、白名单字段与命令解析。
- `src/infrastructure/prisma/agent-conversation-repository.ts`：会话查询、幂等追加、摘要条件更新和 Intake 状态持久化。
- `src/application/build-conversation-context.ts`：以预算构造摘要、消息窗口、Intake 和政策片段上下文。
- `src/application/run-conversation-turn.ts`：问答、政策检索、报销开始、受控字段收集、摘要和确认提交编排。
- `app/api/conversations/*`：员工会话读取、发送、附件和提交确认的归属校验 API。
- `src/worker/feishu-bot.ts`、`src/application/process-feishu-event.ts`：将飞书文本和附件接入统一会话编排。
- `src/ui/agent-conversation-widget.tsx` 与认证布局：全局悬浮入口、历史与 Intake 状态展示；移除草稿页 `ClaimChat`。
- `tests/**`：仓储、应用、API、Worker、UI 和浏览器回归覆盖。

### Task 1: 会话、消息与 Intake 持久化

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_agent_conversations/migration.sql`
- Create: `src/domain/agent-conversation.ts`
- Create: `src/infrastructure/prisma/agent-conversation-repository.ts`
- Create: `tests/integration/agent-conversation-repository.test.ts`

**Interfaces:**
- Produces `AgentConversationRepository` with `getOrCreatePrivate(employeeId)`, `getOrCreateGroup(employeeId, chatId)`, `appendMessage(input)`, `listMessages(input)`, `getCurrentIntake(employeeId)`, `createIntake(input)`, `updateIntake(input)`, and `compareAndSetSummary(input)`.
- `appendMessage` accepts an optional unique `channelMessageId`; duplicate calls return the original message without adding another sequence.
- Later tasks consume `AgentConversation`, `AgentMessage`, and `ReimbursementIntake` IDs only through this repository.

- [ ] **Step 1: Write failing repository integration tests**

Cover shared Web/Feishu private scope, isolated group scope, channel-message idempotency, monotonically ordered sequences, employee cascade deletion, and one active Intake per employee.

- [ ] **Step 2: Run the repository test to verify it fails**

Run: `npm test -- --run tests/integration/agent-conversation-repository.test.ts`

Expected: FAIL because the models and repository do not exist.

- [ ] **Step 3: Add Prisma models, migration, domain types, and repository**

Use database unique constraints for scope and active Intake ownership. Store citations/result as bounded JSON snapshots and enforce message sequence allocation in a transaction.

- [ ] **Step 4: Generate Prisma client and run the repository test**

Run: `npx prisma generate --config prisma7.config.ts && npm test -- --run tests/integration/agent-conversation-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma src/domain/agent-conversation.ts src/infrastructure/prisma/agent-conversation-repository.ts tests/integration/agent-conversation-repository.test.ts
git commit -m "feat: persist agent conversations and intakes"
```

### Task 2: 有预算的对话上下文与模型契约

**Files:**
- Create: `src/application/build-conversation-context.ts`
- Modify: `src/infrastructure/model/chat-model.ts`
- Modify: `src/infrastructure/model/openai-compatible-chat-model.ts`
- Create: `tests/unit/application/build-conversation-context.test.ts`
- Modify: `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`

**Interfaces:**
- Produces `buildConversationContext(input): ConversationContext`, containing `summary`, newest-first bounded `messages`, authoritative `intake`, and optional policy citations.
- Extends `ChatModel` with optional `decideConversation(input: ConversationContext): Promise<ConversationDecision>`; allowed actions are `ANSWER`, `START_INTAKE`, `COLLECT_FIELDS`, and `REQUEST_SUBMISSION`.
- Does not include raw attachment/OCR text, foreign employee data, object keys, tokens, or arbitrary claim IDs.

- [ ] **Step 1: Write failing context and model-contract tests**

Assert token/character budgets retain recent messages, summary covers only older sequence ranges, Intake fields override contradictory summary text, and model input only exposes server-provided policy excerpts.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --run tests/unit/application/build-conversation-context.test.ts tests/unit/infrastructure/openai-compatible-chat-model.test.ts`

Expected: FAIL because the context builder and conversation decision method do not exist.

- [ ] **Step 3: Implement bounded context and constrained decision parsing**

Use deterministic character budgets with stable newest-message selection. Validate model JSON with Zod and reject fields outside the Intake allowlist.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run tests/unit/application/build-conversation-context.test.ts tests/unit/infrastructure/openai-compatible-chat-model.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/build-conversation-context.ts src/infrastructure/model tests/unit/application/build-conversation-context.test.ts tests/unit/infrastructure/openai-compatible-chat-model.test.ts
git commit -m "feat: build bounded agent conversation context"
```

### Task 3: 受控报销办理与确认提交用例

**Files:**
- Create: `src/application/run-conversation-turn.ts`
- Modify: `src/application/create-claim-draft.ts`
- Modify: `src/application/upload-receipt.ts`
- Modify: `src/application/submit-claim.ts`
- Create: `tests/unit/application/run-conversation-turn.test.ts`
- Create: `tests/integration/conversation-intake-flow.test.ts`

**Interfaces:**
- Produces `runConversationTurn(input, deps): ConversationTurnResult` with persisted reply, citations, optional Intake state, and an optional safe business result.
- Consumes Task 1 repository, Task 2 context/model contract, existing claim/receipt/extraction/validation/submission services, and `searchPolicyKnowledge`.
- Accepts exact command `确认提交` only when `ReimbursementIntake.status === READY_TO_SUBMIT`.

- [ ] **Step 1: Write failing application and integration tests**

Cover policy-only turns, explicit start, first attachment creating one claim, allowed field collection, manual claim exclusion, stale confirmation rejection, duplicate confirmation idempotency, and server-side validation before submission.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/application/run-conversation-turn.test.ts tests/integration/conversation-intake-flow.test.ts`

Expected: FAIL because conversation turn orchestration does not exist.

- [ ] **Step 3: Implement `runConversationTurn` and Intake transitions**

Route policy questions without an Intake. Reuse existing receipt, claim-field, confirmation-token, validation, and submit services rather than duplicating database writes. Store only server-approved citations and result metadata with each assistant reply.

- [ ] **Step 4: Run the conversation flow suite**

Run: `npm test -- --run tests/unit/application/run-conversation-turn.test.ts tests/integration/conversation-intake-flow.test.ts tests/unit/application/submit-claim.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application tests/unit/application/run-conversation-turn.test.ts tests/integration/conversation-intake-flow.test.ts
git commit -m "feat: handle reimbursement intakes in conversations"
```

### Task 4: 员工会话 API 与授权边界

**Files:**
- Create: `app/api/conversations/private/route.ts`
- Create: `app/api/conversations/private/messages/route.ts`
- Create: `app/api/conversations/private/attachments/route.ts`
- Create: `tests/integration/api/conversation-routes.test.ts`
- Modify: `UX-CONTRACT.md`

**Interfaces:**
- `GET /api/conversations/private` returns the logged-in employee's private conversation, newest bounded history, active Intake, and safe citation snapshots.
- `POST /api/conversations/private/messages` and `POST /api/conversations/private/attachments` route through Task 3; only the message body `确认提交` may request submission.

- [ ] **Step 1: Write failing API integration tests**

Assert employees cannot read another employee's conversation or Intake, no policy-only message creates a claim, messages retain citations, attachments create at most one Intake, and confirmation errors expose safe recovery text.

- [ ] **Step 2: Run the API test to verify it fails**

Run: `npm test -- --run tests/integration/api/conversation-routes.test.ts`

Expected: FAIL because conversation routes do not exist.

- [ ] **Step 3: Implement routes with session-derived identity**

Use `getSessionActorId` and server-side repository lookups. Map model/provider failures to existing safe error conventions; never return raw model/provider errors or hidden message data.

- [ ] **Step 4: Run API and authorization regression tests**

Run: `npm test -- --run tests/integration/api/conversation-routes.test.ts tests/integration/api/session.test.ts tests/unit/server/policy-authorization.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/conversations src tests/integration/api/conversation-routes.test.ts UX-CONTRACT.md
git commit -m "feat: expose authorized conversation APIs"
```

### Task 5: 飞书 Worker 接入统一会话

**Files:**
- Modify: `src/application/process-feishu-event.ts`
- Modify: `src/worker/feishu-bot.ts`
- Modify: `src/infrastructure/prisma/feishu-bot-repository.ts`
- Modify: `tests/unit/application/process-feishu-event.test.ts`
- Modify: `tests/integration/feishu-bot-worker.test.ts`

**Interfaces:**
- Replaces the direct `runAgentTurn` dependency with `runConversationTurn` while retaining existing Feishu inbound event idempotency and attachment download rules.
- Private messages resolve the shared employee private conversation; groups resolve a member-specific group conversation.
- Worker replies only after the assistant message has been persisted; a reply retry cannot append duplicate messages or submit twice.

- [ ] **Step 1: Write failing Feishu application/integration tests**

Cover private Web/Feishu history sharing, group isolation, duplicate event/message retry, policy citations, attachment Intake creation, and exact “确认提交” behavior.

- [ ] **Step 2: Run Feishu tests to verify they fail**

Run: `npm test -- --run tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-worker.test.ts`

Expected: FAIL because the Worker still uses claim-scoped agent turns.

- [ ] **Step 3: Route Feishu events through Task 3**

Preserve `InboundChannelEvent` as event idempotency source. Persist normalized text and assistant result through the conversation repository, then use the existing safe text reply client.

- [ ] **Step 4: Run Feishu and attachment regressions**

Run: `npm test -- --run tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-worker.test.ts tests/integration/feishu-bot-attachment.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/process-feishu-event.ts src/worker/feishu-bot.ts src/infrastructure/prisma/feishu-bot-repository.ts tests/unit/application/process-feishu-event.test.ts tests/integration/feishu-bot-worker.test.ts
git commit -m "feat: route Feishu through agent conversations"
```

### Task 6: Web 悬浮会话入口与草稿页收敛

**Files:**
- Create: `src/ui/agent-conversation-widget.tsx`
- Create: `src/ui/use-agent-conversation.ts`
- Modify: `app/(authenticated)/layout.tsx`
- Modify: `app/(authenticated)/claims/[claimId]/page.tsx`
- Modify: `app/globals.css`
- Modify: `src/ui/claim-types.ts`
- Create: `tests/unit/ui/agent-conversation.test.ts`
- Modify: `tests/e2e/agent-confirmation.spec.ts`

**Interfaces:**
- `AgentConversationWidget` loads the private conversation through Task 4, sends text/attachments, renders saved citations, displays active Intake status, and exposes an explicit “确认提交” button only after the server returns `READY_TO_SUBMIT`; the button sends that exact text through the ordinary message API.
- The widget uses a semantic button and non-modal disclosure panel; it preserves input and actionable error text on failed requests.
- Claim detail no longer renders `ClaimChat`; manual claim flows remain form-only.

- [ ] **Step 1: Write failing UI and browser tests**

Assert the widget shows persisted private history and expandable evidence, no detail-page `AI 澄清` panel remains, a policy-only Web turn does not create a claim, and the floating control is keyboard reachable at narrow width.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/ui/agent-conversation.test.ts && npm run test:e2e -- tests/e2e/agent-confirmation.spec.ts --workers=1`

Expected: FAIL because the widget and API client do not exist.

- [ ] **Step 3: Implement the shared Web conversation widget**

Follow `DESIGN.md`/`UX-CONTRACT.md`: stable busy controls, `aria-live` status, visible focus, reduced-motion-safe disclosure, no browser dialogs, and no optimistic financial submission state. Reuse existing receipt upload constraints and policy evidence formatting.

- [ ] **Step 4: Run UI/browser verification**

Run: `npm test -- --run tests/unit/ui/agent-conversation.test.ts tests/unit/ui/claim-types.test.ts && npm run test:e2e -- tests/e2e/agent-confirmation.spec.ts --workers=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app src/ui app/globals.css tests/unit/ui tests/e2e/agent-confirmation.spec.ts
git commit -m "feat: add floating agent conversation widget"
```

### Task 7: 全链路回归与运维说明

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `UX-CONTRACT.md`
- Create: `tests/integration/cross-channel-conversation.test.ts`

**Interfaces:**
- Cross-channel test drives private Web/Feishu message persistence, group isolation, Intake creation, confirmation, and post-submission history visibility using test doubles rather than real credentials.
- Operations documentation defines worker restart, migration, message retention, safe log fields, and production rollback requirements.

- [ ] **Step 1: Write failing cross-channel integration coverage**

Verify an employee can start in Feishu and continue in Web, while the same employee's group message is absent from private history; verify submitted result is visible without changing the conversation's identity.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/cross-channel-conversation.test.ts`

Expected: FAIL until Tasks 1–6 are connected.

- [ ] **Step 3: Add operational documentation and complete cross-channel wiring**

Document the migration order, required Worker restart, account-scoped retention, safe recovery for failed replies, and the rule that chat history is not a source of claim facts.

- [ ] **Step 4: Run complete verification**

Run: `npx prisma generate --config prisma7.config.ts && npx tsc --noEmit && npm run lint && npm test && npm run build && docker compose config`

Expected: PASS; lint may retain only known generated-worktree warnings and must have no errors.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/operations.md UX-CONTRACT.md tests/integration/cross-channel-conversation.test.ts
git commit -m "test: cover cross-channel agent conversations"
```

## Spec Coverage Self-Review

- 独立会话、渠道隔离、级联留存与幂等：Task 1。
- 滚动摘要、上下文预算和权威 Intake 事实：Task 2。
- 办理生命周期、字段白名单、草稿复用与确认提交：Task 3。
- Web 会话读取、写入与归属授权：Task 4。
- 飞书 Worker 与事件重试：Task 5。
- 悬浮入口、草稿页收敛和无障碍浏览器验证：Task 6。
- 跨渠道验收、迁移/回滚和运维说明：Task 7。

The plan keeps all public APIs, repository methods, and state names consistent with the design specification. Each review-focus failure mode is covered by Tasks 1, 2, 3, 5, or 6. No task requires an unresolved product decision.
