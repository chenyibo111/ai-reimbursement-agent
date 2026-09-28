# 飞书 OCR 异步结果通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在飞书会话上传票据后，OCR 异步任务结束时主动且可靠地向原会话发送识别摘要、待确认字段或人工复核状态。

**Architecture:** 以 `ReceiptExtractionNotification` 作为只针对飞书上传的持久化 Outbox。上传路径在创建 OCR `AsyncJob` 后写入通知目标；飞书机器人 Worker 轮询终态任务关联的通知、用飞书发送 API 投递并原子地记录状态。`job-worker` 仍只负责 OCR 和任务状态，不依赖飞书 SDK。

**Tech Stack:** Next.js/TypeScript、Prisma/PostgreSQL、Vitest、飞书 Open API、现有 Docker Compose Workers。

**Spec:** `docs/superpowers/specs/2026-09-28-feishu-ocr-result-notification-design.md`

## Global Constraints

- 仅 `FEISHU` 会话附件创建通知；Web 上传不创建通知也不调用飞书 API。
- 通知内容为确定性模板；不调用大模型，不泄漏对象存储键、访问令牌、原始 OCR 全文或复核内部信息。
- 关键字段为发票号码、开票日期、价税合计，低于 `0.9` 或无值均须明确标为待确认。
- 通知投递失败只影响通知 Outbox；不得重跑 OCR、修改票据字段或改变复核结论。
- 每个 OCR 任务最多一条通知；发送使用通知 ID 作为飞书消息幂等键。

## Review Focus

- 同一飞书附件事件重投：唯一 `jobId` 通知记录仍只能投递一次。
- OCR 成功但三个关键字段之一缺失或置信度为 `0`：消息必须列出该字段为待确认。
- `REVIEW_REQUIRED` 的低置信度 OCR：消息必须提示人工复核，不能把低置信度值表述为确定信息。
- 通知发送成功后进程崩溃：再次领取时沿用通知 ID 作为飞书幂等键，避免可见重复。
- Web 上传：即使 OCR 成功，也不能生成通知记录或调用 `sendText`。

---

### Task 1: 持久化 OCR 通知 Outbox

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260928110000_add_receipt_extraction_notifications/migration.sql`
- Create: `src/infrastructure/prisma/receipt-extraction-notification-repository.ts`
- Test: `tests/integration/receipt-extraction-notification-repository.test.ts`

**Interfaces:**
- Produces: `ReceiptExtractionNotificationRepository`，提供 `createForFeishuUpload`、`recoverExpiredLeases`、`claimNextDeliverable`、`markSent`、`markRetryWait`、`close`。
- Consumes: `AsyncJob` 的终态（`SUCCEEDED`、`REVIEW_REQUIRED`、`CLOSED`）与关联的票据、报销单、会话。

- [ ] **Step 1: Write the failing repository integration tests**

覆盖同一 `jobId` 并发创建只能得到一条记录、仅终态任务可被领取、一个并发 Worker 获得租约、过期租约可恢复，以及成功投递后状态为 `SENT`。

- [ ] **Step 2: Run the new integration test to verify it fails**

Run: `npm test -- tests/integration/receipt-extraction-notification-repository.test.ts`

Expected: FAIL，因为 Prisma 模型和 Repository 尚不存在。

- [ ] **Step 3: Add the Prisma model, enum and migration**

定义唯一 `jobId`、`status + availableAt` 索引、`FEISHU` 渠道、投递目标 `chatId`、会话/票据/报销单关联、尝试次数、租约和失败码。保持删除票据或草稿时通知可关闭而非悬挂。

- [ ] **Step 4: Implement `ReceiptExtractionNotificationRepository`**

使用现有 `AsyncJob` 领取模式的条件更新与指数退避规则。`claimNextDeliverable(now, leaseMs)` 只返回终态 OCR 任务的可投递记录，并包含格式化消息所需的 `extractionPayload` 和任务状态。

- [ ] **Step 5: Run the repository integration test to verify it passes**

Run: `npm test -- tests/integration/receipt-extraction-notification-repository.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit the schema and repository task**

```bash
git add prisma src/infrastructure/prisma/receipt-extraction-notification-repository.ts tests/integration/receipt-extraction-notification-repository.test.ts
git commit -m "feat: persist receipt extraction notifications"
```

### Task 2: 在飞书附件上传时创建通知目标

**Files:**
- Modify: `src/application/upload-receipt.ts`
- Modify: `src/application/run-conversation-turn.ts`
- Modify: `src/application/process-feishu-event.ts`
- Modify: `src/worker/feishu-bot.ts`
- Test: `tests/unit/application/run-conversation-turn.test.ts`
- Test: `tests/integration/feishu-bot-attachment.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createForFeishuUpload({ jobId, receiptId, claimId, conversationId, chatId })`。
- Produces: `uploadReceipt` 返回 `{ id, jobId }`；`RunConversationTurnDeps.onReceiptQueued` 收到飞书上下文与任务 ID。

- [ ] **Step 1: Write failing upload/conversation tests**

断言飞书附件上传把返回的 OCR `jobId`、`chatId` 和会话 ID 传给 `onReceiptQueued`；Web 渠道或没有 `chatId` 时绝不调用该回调；首条即时回复仍为“正在识别”语义。

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- tests/unit/application/run-conversation-turn.test.ts tests/integration/feishu-bot-attachment.test.ts`

Expected: FAIL，因为上传结果没有 `jobId`，也没有通知回调。

- [ ] **Step 3: Return the queued job ID from `uploadReceipt`**

将 `jobs.enqueueJob` 的返回类型收窄为 `{ id: string }`，并让上传返回 `{ id: receipt.id, jobId }`；不改变 Web 上传 API 的已有票据响应格式。

- [ ] **Step 4: Add optional FEISHU-only notification scheduling hook**

为会话输入增加可选 `chatId`，附件处理仅在 `channel === "FEISHU"` 且存在 `chatId` 时调用 `onReceiptQueued`。在 `processFeishuEvent` 传递受验证的 chat ID；在 `feishu-bot.ts` 用 Task 1 Repository 落库。

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npm test -- tests/unit/application/run-conversation-turn.test.ts tests/integration/feishu-bot-attachment.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit the upload scheduling task**

```bash
git add src/application src/worker/feishu-bot.ts tests/unit/application/run-conversation-turn.test.ts tests/integration/feishu-bot-attachment.test.ts
git commit -m "feat: queue Feishu OCR result notifications"
```

### Task 3: 生成安全且明确的识别结果消息

**Files:**
- Create: `src/application/format-receipt-extraction-notification.ts`
- Test: `tests/unit/application/format-receipt-extraction-notification.test.ts`

**Interfaces:**
- Consumes: Task 1 领取记录中的 OCR 任务状态、`extractionPayload`、`claimId` 和 `publicAppUrl`。
- Produces: `formatReceiptExtractionNotification(input): string`。

- [ ] **Step 1: Write failing formatter unit tests**

覆盖高置信度完整票据、缺少开票日期与金额的票据、低置信度发票号、`REVIEW_REQUIRED`、无识别载荷/已关闭任务，并断言每条消息包含对应工作台链接且不包含原始 OCR 全文。

- [ ] **Step 2: Run the formatter test to verify it fails**

Run: `npm test -- tests/unit/application/format-receipt-extraction-notification.test.ts`

Expected: FAIL，因为格式化函数尚不存在。

- [ ] **Step 3: Implement deterministic message formatter**

以 `0.9` 作为关键字段确认阈值；金额显示为人民币两位小数；只有高置信度字段可作为“已识别”结果展示。低置信度值可被标示为“待确认识别值”，不得作为确定字段。

- [ ] **Step 4: Run the formatter test to verify it passes**

Run: `npm test -- tests/unit/application/format-receipt-extraction-notification.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit the message formatter task**

```bash
git add src/application/format-receipt-extraction-notification.ts tests/unit/application/format-receipt-extraction-notification.test.ts
git commit -m "feat: format OCR result notifications"
```

### Task 4: 投递通知并写入会话历史

**Files:**
- Modify: `src/infrastructure/feishu/feishu-bot-client.ts`
- Modify: `src/worker/feishu-bot.ts`
- Create: `src/application/deliver-receipt-extraction-notifications.ts`
- Test: `tests/unit/application/deliver-receipt-extraction-notifications.test.ts`
- Test: `tests/integration/feishu-bot-worker.test.ts`
- Test: `tests/integration/docker-worker-compose.test.ts`

**Interfaces:**
- Consumes: Task 1 Repository 领取接口和 Task 3 的 `formatReceiptExtractionNotification`。
- Produces: `deliverReceiptExtractionNotificationOnce(deps): Promise<boolean>` 与 `FeishuBotClient.sendText(chatId, text, uuid)`。

- [ ] **Step 1: Write failing notification delivery tests**

断言成功时调用 `sendText`（UUID 等于通知 ID）、标记 `SENT`、向关联对话追加 `ASSISTANT/FEISHU` 消息；飞书临时失败进入重试；已发送记录不再发送；Web 上传无记录时不调用发送。

- [ ] **Step 2: Run delivery tests to verify they fail**

Run: `npm test -- tests/unit/application/deliver-receipt-extraction-notifications.test.ts tests/integration/feishu-bot-worker.test.ts`

Expected: FAIL，因为发送 API 和通知 Drainer 尚不存在。

- [ ] **Step 3: Add `FeishuBotClient.sendText(chatId, text, uuid)`**

调用飞书“发送消息”接口，使用 `receive_id_type=chat_id` 和 `uuid`；复用租户 token、Provider 错误分类和 JSON 响应校验，且不记录 token。

- [ ] **Step 4: Implement delivery use case and wire it into the bot Worker interval**

在每轮机器人 Worker 定时循环中先/后执行一次通知投递。成功时写会话历史和 `SENT`；可用性错误使用有限重试；授权、资源不存在、无目标或耗尽重试时 `CLOSED` 并记录错误码。保持原始飞书入站事件的 drain 行为不变。

- [ ] **Step 5: Run delivery and Compose tests to verify they pass**

Run: `npm test -- tests/unit/application/deliver-receipt-extraction-notifications.test.ts tests/integration/feishu-bot-worker.test.ts tests/integration/docker-worker-compose.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit the delivery task**

```bash
git add src/application/deliver-receipt-extraction-notifications.ts src/infrastructure/feishu/feishu-bot-client.ts src/worker/feishu-bot.ts tests
git commit -m "feat: send Feishu OCR result notifications"
```

### Task 5: 端到端验证与运维说明

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Test: `tests/integration/feishu-ocr-notification-flow.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 的真实 Prisma Repository、任务状态和飞书客户端测试替身。
- Produces: 可重复的验收链路和用于排障的状态/日志查询命令。

- [ ] **Step 1: Write a failing end-to-end integration test**

构造飞书上传产生的 OCR 任务与 Outbox，模拟 OCR 低置信度进入 `REVIEW_REQUIRED`，断言最终只发送一条含待确认字段、人工复核提示和工作台链接的会话消息。

- [ ] **Step 2: Run the flow test to verify it fails or exposes a missing integration**

Run: `npm test -- tests/integration/feishu-ocr-notification-flow.test.ts`

Expected: FAIL，直到 Tasks 1–4 完整接线。

- [ ] **Step 3: Add operator documentation**

说明即时上传确认与异步结果是两条消息；列出通知 Outbox 状态含义、查看 SQL、Worker 日志关键字、飞书发送权限要求和本地/生产验收步骤。

- [ ] **Step 4: Run full verification**

Run: `npm test; npx tsc --noEmit; docker compose config`

Expected: 全部通过；Compose 配置可解析。

- [ ] **Step 5: Commit the flow test and documentation**

```bash
git add README.md docs/operations.md tests/integration/feishu-ocr-notification-flow.test.ts
git commit -m "docs: document Feishu OCR notification operations"
```
