# Web Agent 确认式填单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将报销工作台的本地对话框升级为可配置 OpenAI-compatible 模型驱动的报销 Agent：员工可在对话中上传票据，Agent 只能提出字段建议，且任何字段变化都必须由员工显式确认后才会写入报销单。

**Architecture:** 服务端构造不含内部 ID、对象存储地址或文件原文的最小化报销上下文，并通过模型适配器得到严格受限的 JSON 决策。服务端校验目标引用和值、持久化建议；浏览器仅能对建议执行“接受/忽略”，后端重新读取建议并以乐观锁写入真实单据。附件沿用同一上传与 OCR 流水线，Web UI 作为未来飞书入口可复用的业务适配层。

**Tech Stack:** Next.js 15 App Router、TypeScript、Prisma 7、PostgreSQL、Zod、React、Vitest、Playwright、OpenAI-compatible Chat Completions API。

**Spec:** `docs/superpowers/specs/2026-09-24-web-agent-confirmation-design.md`

## Global Constraints

- Agent 绝不直接调用字段更新或提交接口；模型输出仅能创建 `PENDING` 建议。
- 不向模型发送数据库 ID、MinIO object key、下载 URL、原始票据字节、用户会话信息或环境变量值。
- 模型只可提议 `purpose`、`invoiceNumber`、`issuedOn`、`totalAmountCents`；金额保持“分”的整数，日期为 `YYYY-MM-DD`。
- 每次接受建议都必须在服务端检查登录员工、草稿状态、建议状态、建议所属单据与 `expectedVersion`；浏览器提交的字段和值一律不可信。
- 现有人工“修正低置信 OCR 字段”接口继续仅允许低置信字段；确认 Agent 建议走单独的受控应用服务，并留下审计事件。
- 生产环境只允许显式设置 `MODEL_PROVIDER=openai-compatible` 及完整模型配置；`fixture` 只能作为本地开发和自动测试的明确选择。
- 上传后的 OCR、重复票据校验、提交前校验仍是唯一事实来源。Agent 不得绕过这些业务规则。
- 新环境变量只写入 `.env.example` 和文档，绝不写入或提交 `.env.local`。

## Public Interfaces and State

```ts
type AgentTargetRef = "claim" | `expense-${number}`;

type AgentProposalInput = {
  target: AgentTargetRef;
  field: "purpose" | "invoiceNumber" | "issuedOn" | "totalAmountCents";
  value: string | number;
  reason: string;
};

type AgentTurnResponse = {
  reply: string;
  proposals: Array<{
    id: string;
    target: AgentTargetRef;
    field: AgentProposalInput["field"];
    displayValue: string;
    reason: string;
    status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
    claimVersion: number;
  }>;
  clarifications: Clarification[];
};
```

`expense-1` 等目标引用只存在于当前服务端构建的 Agent 上下文和持久化建议中；模型从不接触 `ExpenseItem.id`。服务端会在创建建议时解析并存储对应 `expenseItemId`，接受时不再信任或解析浏览器传入的目标、字段和值。

## Review Focus

1. **模型配置缺失或泄漏密钥**：任务 1 的配置单测和环境变量审查保证 provider 不能在生产静默回退，日志不能输出 Authorization 值。
2. **供应商返回非 JSON、超时或超出白名单的字段**：任务 2 的适配器测试与任务 3 的 Zod 解析必须将其转为安全回复，不能创建建议或改变单据。
3. **伪造 target、跨单据 suggestion 或任意字段写入**：任务 3/4 的服务端映射、归属校验和 API 集成测试必须拒绝，客户端绝不能携带真实字段值作为确认依据。
4. **过期建议覆盖新编辑**：任务 4 的乐观锁测试应证明任何版本不一致、已处理或非草稿状态的建议都返回冲突且不更新数据。
5. **上传入口行为分叉或 UI 未回显处理状态**：任务 5/6 应复用一个上传 hook，并以组件和浏览器测试覆盖上传、OCR 完成、建议接受/忽略与刷新后的持久状态。

---

### Task 1: 建立 Agent 提案数据模型与迁移

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260924210000_add_agent_field_proposals/migration.sql`
- Modify: `src/domain/claim.ts`
- Modify: `src/domain/agent.ts`
- Modify: `src/infrastructure/prisma/claim-repository.ts`
- Create: `src/domain/agent-proposal.ts`
- Create: `tests/unit/domain/agent-proposal.test.ts`

- [ ] **Step 1: Write the failing domain test.**

  Add tests proving `parseAgentProposal` accepts only these combinations: `claim/purpose`, `expense-N/invoiceNumber`, `expense-N/issuedOn`, and `expense-N/totalAmountCents`. Include invalid target `expense-0`, an arbitrary `employeeName` field, non-integer cents, an invalid calendar date, and an invoice proposal aimed at `claim`; every invalid input must throw a domain validation error.

- [ ] **Step 2: Run the test to verify it fails.**

  Run: `npm test -- tests/unit/domain/agent-proposal.test.ts`

  Expected: failure because `src/domain/agent-proposal.ts` does not exist.

- [ ] **Step 3: Add the persistent proposal contract.**

  In Prisma add enum `AgentProposalStatus { PENDING ACCEPTED REJECTED EXPIRED }` and model `AgentFieldProposal` with `id`, `claimId`, nullable `expenseItemId`, `targetRef`, `field`, `value Json`, `reason`, `claimVersion`, `status`, `createdAt`, `resolvedAt`, and relations to `ClaimDraft` and `ExpenseItem`. Add reverse relations with cascade deletion to preserve existing single-tenant cleanup behavior. Create the SQL migration with the matching enum, table, indexes on `(claim_id, status)` and `(claim_id, created_at)`, foreign keys, and no default that can silently mark a proposal accepted.

  Define the domain whitelist and normalization in `src/domain/agent-proposal.ts`. Normalize date values before persistence, reject `NaN`/floating amounts, constrain strings to nonempty bounded lengths, and expose `formatProposalValue` for the UI DTO. Replace the former `update_claim_field` model tool semantics with proposal types; update the fixture model and its existing domain tests to emit the same proposal contract.

- [ ] **Step 4: Extend claim read models.**

  Add a server-owned `agentProposals` list to the claim summary returned by `PrismaClaimRepository`/`ClaimSummary`. The DTO must expose only id, target ref, field, display value, reason, status, claim version, and timestamps; it must omit `expenseItemId` and raw JSON internals. Sort pending proposals first, then newest creation time.

- [ ] **Step 5: Run schema and domain checks.**

  Run: `npm exec prisma generate --config prisma7.config.ts && npm test -- tests/unit/domain/agent-proposal.test.ts`

  Expected: Prisma client generation succeeds and all proposal whitelist tests pass.

- [ ] **Step 6: Commit the data-model slice.**

  ```bash
  git add prisma src/domain src/infrastructure/prisma tests/unit/domain
  git commit -m "feat: persist confirmed agent field proposals"
  ```

### Task 2: 实现 OpenAI-compatible 模型适配器与安全配置

**Files:**

- Modify: `src/server/config.ts`
- Modify: `src/infrastructure/model/chat-model.ts`
- Create: `src/infrastructure/model/openai-compatible-chat-model.ts`
- Create: `src/infrastructure/model/chat-model-factory.ts`
- Modify: `src/infrastructure/model/fake-chat-model.ts`
- Create: `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write failing adapter tests using a mocked fetch.**

  Test that the adapter sends exactly one `POST` to `${MODEL_BASE_URL}/chat/completions`, carries the configured model, uses an Authorization bearer header without placing the key in the request body, and returns parsed JSON from `choices[0].message.content`. Add cases for an HTTP 401, a timeout/aborted request, an empty choices list, and a non-JSON message; each must throw a typed `ChatModelError` whose public message does not contain endpoint credentials or provider response body.

- [ ] **Step 2: Run the adapter test to verify it fails.**

  Run: `npm test -- tests/unit/infrastructure/openai-compatible-chat-model.test.ts`

  Expected: failure because the OpenAI-compatible adapter and factory do not exist.

- [ ] **Step 3: Define explicit configuration.**

  Extend `serverConfig` with `MODEL_PROVIDER`, `MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY`, and optional bounded `MODEL_TIMEOUT_MS` (default 20 seconds). `openai-compatible` requires all endpoint/model/key fields; `fixture` is allowed only under `NODE_ENV !== "production"`. Reject unknown providers early. Do not log configuration objects or response headers.

  Add commented, valueless examples to `.env.example` and a README section documenting the generic `/v1` base URL convention, model name, restart requirement, and that `.env.local` stays private. Do not document any provider-specific or user-specific secret.

- [ ] **Step 4: Implement the adapter and factory.**

  Keep `ChatModel.decide` accepting a structured server context. The adapter must use Node `fetch` and `AbortSignal.timeout`, request a deterministic low-temperature JSON response, and parse only the assistant content. The system instruction must say: return one JSON object matching `reply` plus `proposals`; never invoke tools, never claim an update is complete, and ask a clarification when candidate data is insufficient. The factory selects `FakeChatModel` only for explicit local/test fixture configuration and `OpenAiCompatibleChatModel` otherwise.

  The prompt payload must contain only public claim facts, validation issues, safe `expense-N` references, and server-computed allowed fields. It must omit real IDs, file paths, OCR raw payloads, object keys, cookies, authorization values, and previous user free text beyond the current message.

- [ ] **Step 5: Run tests and static checks.**

  Run: `npm test -- tests/unit/infrastructure/openai-compatible-chat-model.test.ts && npm run lint && npx tsc --noEmit`

  Expected: adapter success and failure modes pass; lint/typecheck have no errors.

- [ ] **Step 6: Commit the provider slice.**

  ```bash
  git add src/server/config.ts src/infrastructure/model .env.example README.md tests/unit/infrastructure
  git commit -m "feat: add OpenAI-compatible agent model adapter"
  ```

### Task 3: 构造最小化上下文并将模型输出变为待确认建议

**Files:**

- Modify: `src/application/run-agent-turn.ts`
- Create: `src/application/build-agent-context.ts`
- Modify: `src/application/get-claim-summary.ts`
- Modify: `app/api/claims/[claimId]/chat/route.ts`
- Modify: `src/server/stored-claim-validation.ts`
- Modify: `tests/unit/application/run-agent-turn.test.ts`
- Create: `tests/unit/application/build-agent-context.test.ts`

- [ ] **Step 1: Write failing context and turn tests.**

  In `build-agent-context.test.ts`, create a claim with UUID-like IDs, an object key, two expense items, and one low-confidence issue. Assert the returned context contains `expense-1` but none of the IDs/object key/raw payload. Assert it exposes only the exact permitted target/field pairs derived from current validation: missing purpose produces `claim/purpose`; a low-confidence invoice produces `expense-1/invoiceNumber`.

  In `run-agent-turn.test.ts`, use a fake model that returns one valid proposal and assert a pending proposal with the mapped `expenseItemId`, current claim version and audit event `AGENT_FIELD_PROPOSED` is stored. Add malformed JSON, unavailable target, and disallowed field cases; assert safe clarification/reply is returned, no proposal is stored, and `MODEL_RESPONSE_REJECTED` is audited.

- [ ] **Step 2: Run the tests to verify they fail.**

  Run: `npm test -- tests/unit/application/build-agent-context.test.ts tests/unit/application/run-agent-turn.test.ts`

  Expected: failure because no context builder or proposal-persistence path exists.

- [ ] **Step 3: Build a fresh, server-owned Agent context.**

  `buildAgentContext` must load the authenticated employee's draft through the existing repository, calculate validation using the persisted receipts/items and active duplicate results, and generate stable positional target references. Candidate pairs are derived only from actionable validation results, so the model cannot propose to a high-confidence field merely because it can guess its name. Create an in-memory mapping from each `expense-N` to the associated `expenseItemId`; do not serialize it into the prompt or browser response.

  Refactor the chat route away from its current hand-built empty `fields`/`duplicate: false` validation input. It must use the persisted validation path shared with the claim page/submit flow, preserving actual confidence and duplicate findings.

- [ ] **Step 4: Change the turn orchestration.**

  Make `runAgentTurn` receive the safe context, invoke `ChatModel`, Zod-parse `reply` and `proposals`, run every proposal through `parseAgentProposal`, resolve only known target mappings, and persist valid records as `PENDING`. A single invalid model candidate should be rejected individually and audited without converting it into a field mutation. Return persisted public proposal DTOs plus clarifications; do not return tool calls or untrusted value objects for client-side mutation.

  Include the user message only in the model prompt for the current turn. Limit its trimmed length server-side, and return a validation error for empty content when no attachment action preceded it.

- [ ] **Step 5: Make the route observable without revealing sensitive details.**

  The chat API response shape becomes `AgentTurnResponse`. On provider failure, return a user-safe 503 response such as “AI 服务暂不可用，请稍后重试或直接编辑字段”; server logs may include an error category and request id, never model content, credentials, or receipt content. Continue checking employee ownership before reading the claim.

- [ ] **Step 6: Run application tests.**

  Run: `npm test -- tests/unit/application/build-agent-context.test.ts tests/unit/application/run-agent-turn.test.ts`

  Expected: safe-context, valid-proposal, and rejected-output cases pass.

- [ ] **Step 7: Commit the orchestration slice.**

  ```bash
  git add src/application app/api/claims/[claimId]/chat src/server tests/unit/application
  git commit -m "feat: create pending proposals from agent turns"
  ```

### Task 4: 提供仅确认/忽略的受控字段更新接口

**Files:**

- Create: `src/application/resolve-agent-proposal.ts`
- Create: `app/api/claims/[claimId]/agent-proposals/[proposalId]/accept/route.ts`
- Create: `app/api/claims/[claimId]/agent-proposals/[proposalId]/reject/route.ts`
- Modify: `src/application/update-claim-field.ts`
- Modify: `src/infrastructure/prisma/claim-repository.ts`
- Create: `tests/unit/application/resolve-agent-proposal.test.ts`
- Create: `tests/integration/api/agent-proposal-routes.test.ts`

- [ ] **Step 1: Write failing resolution tests.**

  Cover accepting a pending `purpose` proposal and an `expense-1/totalAmountCents` proposal. Assert the real claim changes once, the proposal becomes `ACCEPTED`, `resolvedAt` is populated, claim version advances, and audit `AGENT_FIELD_ACCEPTED` records proposal id/field but not sensitive raw receipt data. Cover rejection changing only status and writing `AGENT_FIELD_REJECTED`.

  Add negative cases: proposal belongs to another employee/claim, stale `expectedVersion`, already rejected/accepted proposal, submitted claim, and a browser body containing a forged `field`/`value`. Each must leave the claim and proposal unchanged. The API route test must prove accept/reject only accept `{ expectedVersion: number }` and never use client-supplied target or value.

- [ ] **Step 2: Run the tests to verify they fail.**

  Run: `npm test -- tests/unit/application/resolve-agent-proposal.test.ts tests/integration/api/agent-proposal-routes.test.ts`

  Expected: failure because resolution service and endpoints do not exist.

- [ ] **Step 3: Implement transactional resolution.**

  Implement `resolveAgentProposal({ employeeId, claimId, proposalId, action, expectedVersion })` as one transaction. Re-read claim and proposal with ownership, check `DRAFT` status, `PENDING` status, proposal `claimVersion === expectedVersion === claim.version`, and resolve the proposal's stored field/value/expense item only after those checks. Call a shared, internal field-update primitive so domain validation remains centralized; do not call an HTTP route from the server.

  On accept, permit only the already-whitelisted proposal tuple and update the matching claim purpose or expense field. On reject, leave claim values unchanged. In both cases mark proposal terminal, set `resolvedAt`, increment claim version once, and audit the action. Translate version/status conflicts to HTTP 409 and ownership/not-found to the project’s existing safe response style.

- [ ] **Step 4: Add route parsing and response DTOs.**

  Require the existing authenticated employee helper. Parse a strict object with the integer `expectedVersion`; reject extra mutation fields. Return the refreshed public proposal plus new claim version so the UI can reconcile without guessing. Do not add a generic PATCH or delete endpoint for proposals.

- [ ] **Step 5: Run resolution tests and full typecheck.**

  Run: `npm test -- tests/unit/application/resolve-agent-proposal.test.ts tests/integration/api/agent-proposal-routes.test.ts && npx tsc --noEmit`

  Expected: valid acceptance/rejection succeeds; forged, stale, cross-claim and terminal-state requests fail safely.

- [ ] **Step 6: Commit the confirmation boundary.**

  ```bash
  git add src/application src/infrastructure/prisma app/api/claims/[claimId]/agent-proposals tests/unit/application tests/integration/api
  git commit -m "feat: require employee confirmation for agent proposals"
  ```

### Task 5: 复用附件上传流水线并完成对话工作台交互

**Files:**

- Create: `src/ui/use-receipt-upload.ts`
- Modify: `src/ui/receipt-upload.tsx`
- Modify: `src/ui/claim-chat.tsx`
- Modify: `app/(authenticated)/claims/[claimId]/page.tsx`
- Create: `tests/unit/ui/claim-chat.test.tsx`
- Create: `tests/unit/ui/use-receipt-upload.test.ts`

- [ ] **Step 1: Write failing UI tests.**

  `use-receipt-upload.test.ts` must mock the existing receipt upload and extract requests, then prove both callers issue the same `POST /receipts` followed by `POST /receipts/:id/extract`, report progress, preserve the original file name, and invoke one refresh callback after OCR finishes.

  `claim-chat.test.tsx` must render a pending proposal card with field label, old/current context, formatted suggested value and reason. Clicking “接受并写入” must send only `expectedVersion` to the accept endpoint, disable both actions while pending, then render `已接受`; clicking “忽略” must render `已忽略` and not alter claim fields. Add a failure assertion that a 409 prompts refresh guidance rather than claiming success.

- [ ] **Step 2: Run the UI tests to verify they fail.**

  Run: `npm test -- tests/unit/ui/use-receipt-upload.test.ts tests/unit/ui/claim-chat.test.tsx`

  Expected: failure because the hook, proposal cards, and action handlers do not exist.

- [ ] **Step 3: Extract one client upload pipeline.**

  Move the existing successful upload/OCR request sequence, progress labels, error conversion, and `onComplete` refresh behavior into `useReceiptUpload({ claimId, onComplete })`. Keep `ReceiptUpload` as the existing full-page/workbench drop-zone consumer. Make `ClaimChat` the compact consumer with an attach-file button and hidden file input. The hook must not alter the current upload API, MIME/size validation, duplicate behavior, or OCR response handling.

  After a chat upload completes, append a local status turn stating the file was received and OCR is complete/needs review, then refresh the parent summary so the receipt table is the canonical display. Do not send file bytes or object URLs to the model.

- [ ] **Step 4: Render durable proposal state.**

  Pass server-loaded `agentProposals` and `claim.version` from `app/(authenticated)/claims/[claimId]/page.tsx` into `ClaimChat`; retain current local conversation turns only for the active browser session. Render persisted pending, accepted, rejected, and expired suggestions on initial load so refresh never loses the decision. Each card must identify the affected business field and suggested value in Chinese, make the confirmation consequence explicit, and avoid showing internal target references or IDs.

  On accept/reject success, call the existing claim refresh path and replace the displayed proposal state from the response. Handle 401/403/409/5xx with actionable Chinese messages; do not optimistically change a field before a successful server response. Maintain keyboard operation, disabled status, and aria labels for file selection and proposal actions.

- [ ] **Step 5: Run UI tests.**

  Run: `npm test -- tests/unit/ui/use-receipt-upload.test.ts tests/unit/ui/claim-chat.test.tsx && npm run lint`

  Expected: the two entry points share upload behavior, proposal confirmation state is persistent, and lint passes.

- [ ] **Step 6: Commit the web interaction slice.**

  ```bash
  git add src/ui app/(authenticated)/claims/[claimId]/page.tsx tests/unit/ui
  git commit -m "feat: add receipt attachments and proposal cards to chat"
  ```

### Task 6: 端到端验证、运维文档与发布前检查

**Files:**

- Create: `tests/e2e/agent-confirmation.spec.ts`
- Modify: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/operations.md`
- Create: `docs/feishu-integration.md`

- [ ] **Step 1: Write the failing browser scenario.**

  Add a Playwright scenario using the explicit fixture model: employee opens a draft, uploads a supported test receipt from the chat attach action, waits for OCR status to settle, sends a clarification message, sees a pending purpose suggestion, accepts it, reloads, and verifies the purpose and `已接受` card remain. In a second scenario, produce a pending suggestion, edit the claim in another request to advance the version, and verify the stale accept displays a refresh message without overwriting the newer value.

- [ ] **Step 2: Run the scenario to verify it fails.**

  Run: `npm run test:e2e -- tests/e2e/agent-confirmation.spec.ts`

  Expected: failure until the chat attachment, suggestion and resolution flows are connected.

- [ ] **Step 3: Document operational boundaries.**

  Update README with local fixture and OpenAI-compatible startup paths, all non-secret environment variable names, model failure behavior, and manual verification URLs. Update architecture documentation with the trust boundary (model proposes → database persists → employee confirms → transactional update) and target-ref mapping. Update operations documentation with migration/generate commands, safe log review, rollback rule (disable `MODEL_PROVIDER=openai-compatible`/restart; do not delete proposals), and alert-worthy statuses. Update Feishu integration documentation to state future bot events must call the same application service and cannot bypass the confirmation endpoint.

- [ ] **Step 4: Run the release verification matrix.**

  Run:

  ```bash
  npm exec prisma generate --config prisma7.config.ts
  npm run lint
  npx tsc --noEmit
  npm test
  npm run test:e2e -- tests/e2e/agent-confirmation.spec.ts
  npm run build
  ```

  Expected: all commands exit 0. Confirm the production check with `MODEL_PROVIDER=fixture` fails before deployment, and confirm no tracked diff includes `.env.local`, an API key, a MinIO credential, or a token.

- [ ] **Step 5: Commit the verification and documentation slice.**

  ```bash
  git add tests/e2e README.md docs
  git commit -m "test: cover agent confirmation workflow"
  ```

## Manual Acceptance Checklist

- [ ] With `MODEL_PROVIDER=fixture`, a local developer can create a draft, upload from both the receipt panel and chat, and receives the same OCR behavior.
- [ ] With a valid OpenAI-compatible endpoint, Agent receives only a minimal redacted summary and returns a clarification or pending proposal; it never changes a field on its own.
- [ ] A user can accept and ignore a proposal, and a reload preserves both field/result state and audit history.
- [ ] A manually edited or submitted claim makes an old proposal unresolvable with a conflict message rather than overwriting new data.
- [ ] Existing direct low-confidence OCR corrections, duplicate checks, validation, draft submission, Feishu OAuth session persistence, list and detail pages continue to work.
- [ ] `git status --short` contains no environment credentials, generated artifacts, or unintended migration files before release.
