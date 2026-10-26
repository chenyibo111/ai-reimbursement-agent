# Agent Field Persistence and Owned Claim Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make four Agent-collected fields truthful Go-backed claim data and let an employee query their own existing claims without changing the active reimbursement Intake.

**Architecture:** Keep the shared Web/Feishu conversation orchestrator in TypeScript. Expand its audited Go tool boundary for typed draft updates and owner-scoped claim lookup; persist a separate read-only claim selection in the Agent conversation. Go remains the sole reimbursement writer and final authorization/version authority.

**Tech Stack:** TypeScript, Zod, Prisma 7/PostgreSQL, Vitest, Go/pgx, OpenAPI, existing Web and Feishu workers.

**Spec:** `docs/superpowers/specs/2026-10-26-agent-field-write-and-owned-claim-lookup-design.md`

## Global Constraints

- Use the current `feature/agent-fields-and-owned-claim-lookup` checkout; no worktree. Preserve unrelated changes.
- Only `purpose`, `expenseCategory`, `participants`, `projectCode` are Agent-writable. Amount, currency and remark remain Web-only.
- The exact text `确认提交` plus the Go confirmation token remains the sole final-submit path. Read selection must never change the active Intake's write/submit target.
- All list, lookup, read and write requests use the actor bound to the Agent tool context; never trust model-supplied employee IDs. Group chat cannot expose claim facts.
- No “saved” reply before Go write and owner-scoped readback agree. A failure or version conflict cannot silently overwrite a Web edit.
- Existing tool-call caching requires distinct, stable IDs for pre-write reads, writes and post-write reads within one turn; replay reuses those IDs.
- Real-model evaluation is opt-in and may incur cost. Automated tests use fixture models and isolated test data.

## Review Focus

1. An employee gives another employee's `BX...` number: owner-scoped exact lookup returns the same safe no-result as a nonexistent number (Task 1 and Task 6 tests).
2. A write succeeds in Go but the readback fails or differs: Agent must not say all fields were saved (Task 5 test).
3. Two tool reads in one turn bracket a PATCH: post-write read cannot replay the cached pre-write snapshot (Task 2 test).
4. An old claim is selected while an Intake is active: read answers come from the selected claim, while all writes/submit confirmation remain bound to the Intake (Task 6 test).
5. A draft changes after submission preparation, or Web changes it between Agent read and PATCH: old confirmation is invalidated and the Agent does not overwrite the Web edit (Task 5 test).

---

### Task 1: Owner-scoped exact claim-number lookup in Go

**Files:** Modify `services/reimbursement-api/internal/application/claim_service.go`, `services/reimbursement-api/internal/store/claim_repository.go`, `services/reimbursement-api/internal/transport/http/claims_handler.go`, `api/openapi/reimbursement-v1.yaml`; test in the neighboring Go `*_test.go` files and `services/reimbursement-api/tests/openapi_compatibility_test.go`.

**Interfaces:** Keep `ListClaims(ctx, actorID, limit)` unchanged. Add `FindClaimByNumber(ctx context.Context, actorID, claimNumber string) (ClaimView, error)` and repository `FindOwnedByNumber(ctx, claimNumber, actorID)`. `GET /api/v1/claims?claimNumber=BX20261009-0026` returns `{items: [claim]}` or `{items: []}`; ordinary list remains unchanged. Exact format is `BX` + eight digits + `-` + at least four digits; invalid query returns 400.

- [ ] **Step 1: Write failing Go tests.** Assert same-owner exact number yields one claim even when more than 100 newer claims exist; foreign and missing numbers both yield an empty `items`; malformed number returns 400; list without `claimNumber` still obeys `limit`.
- [ ] **Step 2: Run `go test ./internal/application ./internal/store ./internal/transport/http ./tests` from `services/reimbursement-api`; expect the new cases to FAIL.**
- [ ] **Step 3: Implement the interface and OpenAPI query parameter.** Repository SQL filters `claim.owner_id = $actorID AND claim.claim_number = $claimNumber`; do not fetch a global number and then filter in TypeScript.
- [ ] **Step 4: Run the same Go tests and `git diff --check`; expect PASS.**
- [ ] **Step 5: Commit** Go API, contract and tests as `feat(go): look up owned claims by exact number`.

### Task 2: Typed Agent tools and unique per-step call IDs

**Files:** Modify `services/agent/src/ports/reimbursement-port.ts`, `services/agent/src/adapters/reimbursement-api-client.ts`, `services/agent/src/tool-gateway/reimbursement-tools.ts`, `services/agent/src/tool-gateway/conversation-reimbursement.ts`; test their adjacent `*.test.ts` files.

**Interfaces:** Extend `ClaimSnapshot` with `expenseCategory: string`, `participants: string[]`, `projectCode: string` alongside its existing `purpose`. Define `ClaimFieldPatch = { purpose?: string; expenseCategory?: string; participants?: string[]; projectCode?: string }` in `ports/reimbursement-port.ts`. Add tool names `list_owned_claims`, `find_owned_claim_by_number`; their conversation adapter methods are `listOwnedClaims(context, limit): Promise<ClaimSnapshot[]>` and `findOwnedClaimByNumber(context, claimNumber): Promise<ClaimSnapshot | null>`. Add `updateFields(context, claimId, fields: ClaimFieldPatch): Promise<ClaimSnapshot>`. `updateFields` performs pre-read, versioned PATCH, then owner-scoped post-read. `execute(context, name, args, operationKey)` uses stable keys `fields.pre-read`, `fields.patch`, `fields.post-read` in the tool-call ID and idempotency key so the two reads cannot alias.

- [ ] **Step 1: Write failing tool/client tests.** Assert GET list and exact lookup forward actor auth; typed PATCH excludes amount/remark; pre-read/write/post-read have three distinct stable IDs; post-read returns the updated Go fields rather than cached old fields; replay of one step reuses its original ID.
- [ ] **Step 2: Run `npx vitest run services/agent/src`; expect the new cases to FAIL.**
- [ ] **Step 3: Implement the ports, client, gateway and adapter.** Validate returned payload shapes at the Agent boundary; keep existing purpose-only callers working until Task 5 replaces them.
- [ ] **Step 4: Run the focused tests and `npx tsc --noEmit`; expect PASS.**
- [ ] **Step 5: Commit** as `feat(agent): add typed owned-claim tools`.

### Task 3: Model decision schema and allowed field extraction

**Files:** Modify `src/infrastructure/model/chat-model.ts`, `src/infrastructure/model/openai-compatible-chat-model.ts`, `src/application/build-conversation-context.ts`, `src/domain/agent-conversation.ts`, `src/application/evaluate-intent.ts`; test `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`, `tests/unit/application/build-conversation-context.test.ts`, `tests/unit/application/evaluate-intent.test.ts`; extend `tests/fixtures/intent-eval/{dev,holdout}.jsonl` with anonymous synthetic list/number-reference cases.

**Interfaces:** Add `LIST_CLAIMS` to `ConversationAction`. `ConversationDecision` may carry `claimNumber?: string` only for read actions and `fields?: ClaimFieldPatch` (from Task 2) only for `COLLECT_FIELDS`; participants are a string array, not a comma-separated model string. `ConversationContext.allowedFields` contains all four fields whenever an Intake is active, independent of `pendingFields` (which continues to track required `purpose`). Server-side bounds: each string trimmed to 1–200 Unicode code points; participants 1–20 distinct names, each 1–80 code points; reject unknown keys and amount/remark proposals. Normalize user-supplied lowercase `bx` to uppercase before exact-number validation.

- [ ] **Step 1: Write failing parsing/context/eval tests.** Assert list intent, valid `BX20261009-0026` reference and participant array parse; non-read `claimNumber`, extra field, 21 participants, amount/remark, and malformed output fail closed; an Intake with no pending fields still permits four edits; old eval fixtures still parse.
- [ ] **Step 2: Run the three focused Vitest files; expect FAIL.**
- [ ] **Step 3: Implement prompt, strict Zod schema, context construction and eval action union; add representative anonymous dev/holdout cases.** The model suggests targets, while the server and Go verify ownership.
- [ ] **Step 4: Run the focused tests and `npx tsc --noEmit`; expect PASS.** Do not call the real model automatically.
- [ ] **Step 5: Commit** as `feat(agent): classify owned-claim reads and typed fields`.

### Task 4: Persist read-only selection separately from Intake

**Files:** Modify `prisma/schema.prisma`, `src/infrastructure/prisma/agent-conversation-repository.ts`; create an additive `prisma/migrations/<timestamp>_agent_read_claim_selection/migration.sql`; test `tests/integration/agent-conversation-repository.test.ts` and `tests/unit/infrastructure/agent-conversation-repository.test.ts`.

**Interfaces:** `AgentConversation.selectedReadClaimId: string | null`, default null, without a cross-schema FK. Add `setSelectedReadClaimId(input: { conversationId: string; claimId: string | null }): Promise<void>`; `getConversationByIdOrThrow` returns the selection. No method changes an Intake claim ID when this selection changes.

- [ ] **Step 1: Write failing repository tests.** Select an old claim, reload the shared private conversation, confirm selection persists and Intake claim ID is unchanged; clearing selection restores null; group conversation remains separate.
- [ ] **Step 2: Apply the additive migration to the isolated test database and run focused tests; expect FAIL before repository implementation.**
- [ ] **Step 3: Implement the Prisma field and repository method; generate Prisma client.** Do not make the selection authoritative for ownership.
- [ ] **Step 4: Run focused tests and `npx tsc --noEmit`; expect PASS.**
- [ ] **Step 5: Commit** migration, repository and tests as `feat(agent): persist read-only claim selection`.

### Task 5: Go-backed field write and truthful acknowledgement

**Files:** Modify `src/application/run-conversation-turn.ts`, `src/agent/reimbursement-runtime.ts`, `src/worker/feishu-bot.ts`, `app/api/conversations/private/messages/route.ts`, `app/api/conversations/private/attachments/route.ts`; optionally create `src/application/conversation-claim-fields.ts` to keep the orchestrator focused; test `tests/unit/application/run-conversation-turn.test.ts`, `tests/integration/conversation-intake-flow.test.ts`, `tests/integration/api/conversation-routes.test.ts`.

**Interfaces:** Add `updateFields(input: { actorId; claimId; fields: ClaimFieldPatch }): Promise<ClaimSnapshot>` to `RunConversationTurnDeps`; replace `updatePurpose`. `COLLECT_FIELDS` with a valid proposal creates a Go draft only if needed, binds its ID, writes all proposed fields in one versioned PATCH where needed, checks the post-read values, then updates Intake and acknowledges only verified values. Return a safe partial-failure reply if create succeeded but PATCH/readback failed. A successful edit invalidates any previous submission token.

- [ ] **Step 1: Write failing turn/integration tests.** Cover no draft on `START_INTAKE`, first-field draft creation, four fields visible via Go readback and Web query, unsupported amount/remark rejected, write/readback mismatch not acknowledged, Go version conflict not overwritten, old Intake-only JSON not treated as saved, successful edit after `READY_TO_SUBMIT` clearing token, and replay of one inbound message producing only one draft/PATCH.
- [ ] **Step 2: Run the focused Vitest files; expect FAIL.**
- [ ] **Step 3: Implement the write orchestration and wire both entrypoints to Task 2 tools.** Ensure a replay uses stable operation keys; do not put field values in logs. If Go create succeeds but subsequent write fails, persist/bind the created claim ID before returning the safe partial-failure reply.
- [ ] **Step 4: Run focused tests, `npx tsc --noEmit` and `git diff --check`; expect PASS.**
- [ ] **Step 5: Commit** as `feat(agent): persist collected fields through Go`.

### Task 6: Existing-claim listing, selection and safe reads

**Files:** Modify `src/application/run-conversation-turn.ts` and both entrypoint wiring files from Task 5; optionally create `src/application/conversation-claim-read.ts`; test `tests/unit/application/run-conversation-turn.test.ts`, `tests/integration/cross-channel-conversation.test.ts`, `tests/integration/feishu-bot-worker.test.ts`.

**Interfaces:** Add `listOwnedClaims` and `findOwnedClaimByNumber` to `RunConversationTurnDeps` using Task 2 tools, and `setSelectedReadClaimId` using Task 4 repository. `LIST_CLAIMS` formats at most five recent owner claims. A read with an explicit number resolves via Go and stores selection; subsequent read chooses selection before Intake. Starting a new Intake clears selection. All writes and submission paths still use only Intake claim ID.

- [ ] **Step 1: Write failing turn/channel tests.** Cover list of five or fewer, exact old-number lookup beyond recent list, follow-up “这单金额”, missing/foreign number with identical safe reply, group denial, active Intake plus old read selection, clearing selection only after a new Intake is actually created, and old selection not becoming the write/submit target.
- [ ] **Step 2: Run the focused Vitest files; expect FAIL.**
- [ ] **Step 3: Implement read target resolution and safe formatting.** Never infer an owner from model text; Go rechecks owner on every detail read. No target plus several candidates asks for a number instead of guessing.
- [ ] **Step 4: Run focused tests and `npx tsc --noEmit`; expect PASS.**
- [ ] **Step 5: Commit** as `feat(agent): query owned claims without rebinding intake`.

### Task 7: Full regression, docs and human acceptance

**Files:** Modify `README.md` and relevant Agent acceptance docs; test `tests/e2e/agent-confirmation.spec.ts` plus any contract test impacted by Task 1.

**Interfaces:** No new product API. Acceptance follows the spec's field, owner-isolation, read-selection and confirmation-token scenarios.

- [ ] **Step 1: Add browser E2E/contract assertions** for user-visible saved fields, own-claim list and explicit selection, and unchanged submit target; run them and fix any integration failure. Unit and service tests already provide the RED checks before each feature implementation.
- [ ] **Step 2: Run Go tests, `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, React app tests/build, and the relevant Playwright E2E tests.** Record exact counts and any unrelated warnings; do not mark acceptance complete for an unrun command.
- [ ] **Step 3: Run a real-model intent evaluation only with explicit user approval for model requests/cost; otherwise report it as pending.** Do not log the employee's raw text in the observability platform.
- [ ] **Step 4: Manually verify private Feishu and Web with an authorized employee, a second employee for cross-owner denial, and a prepared submission invalidated by field edit.** If external account access is unavailable, give exact user steps and leave this checkbox pending.
- [ ] **Step 5: Update docs, review the full diff for secrets and authorization regressions, then commit final tests/docs.** Do not merge or push without the user's request.
