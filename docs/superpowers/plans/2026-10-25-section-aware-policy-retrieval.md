# Section-Aware Policy Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Policy questions retrieve complete, relevant policy sections instead of silently losing adjacent rules or text after a 500-character cut.

**Architecture:** Read structured Feishu Docx blocks, build ordered heading-path sections and smaller embedding chunks, persist them as immutable versioned snapshots, then expand vector hits to complete parent-topic families when subordinate headings split city tiers. Display citations remain short and separate from model evidence; oversized evidence is marked incomplete.

**Tech Stack:** TypeScript, Next.js 15, Vitest, Prisma 7, PostgreSQL/pgvector, Feishu Docx API, existing Embedding Provider and chat model.

**Spec:** `docs/superpowers/specs/2026-10-25-section-aware-policy-retrieval-design.md`

**执行状态（2026-10-26）：** Task 1–4 与 Task 5 的代码、测试、构建已完成。原文中的嵌入电子表格已由用户替换为普通文档表格。补充修正迁移将误落入连接用户 schema 的 `PolicySection` 安全移至 `public` 后，授权来源已真实同步为 v2 活动快照（51 个章节、51 个检索片）。实际向量检索的宽泛住宿问题与北京上海定向问题均命中同一个完整住宿费章节，含 600/500/400 元三档。用户已确认飞书端人工问答验证完成；Web 端最终回答尚未单独确认。

## Global Constraints

- Use the current checkout; do not create a worktree. Preserve unrelated changes.
- Keep document content read-only and untrusted; no model-generated executable policy rules.
- Only enabled sources and active snapshots are searchable; a failed sync must not replace the active snapshot.
- Embedding vectors remain 1024-dimensional. Initial retrieval: at most 12 chunk hits, three selected topic families, and 8,000 characters of model evidence.
- `indexVersion = 2` forces rebuilding unchanged source content; old snapshots remain readable until replacement succeeds.
- Sync API returns an enqueued job, not completed counts. Display counts from the active snapshot in the existing admin source list.

## Review Focus

1. A Docx with a paginated, nested heading/list/table sequence retains document order, so a rate table is not rearranged (Task 1 test).
2. A single policy paragraph longer than 500 characters preserves its tail for model evidence (Tasks 2 and 4 tests).
3. Identical source text under an old index version gets reindexed without violating snapshot uniqueness (Task 3 test).
4. Failed parsing or embedding keeps the previous active snapshot searchable (Task 3 test).
5. An over-budget section yields an explicit incomplete-evidence response, not a seemingly complete policy answer (Task 4 test).

---

### Task 1: Structured Feishu document reader

**Files:**
- Modify: `src/infrastructure/feishu/feishu-policy-document-client.ts`
- Test: `tests/unit/infrastructure/feishu-policy-document-client.test.ts`

**Interfaces:**
- Produce `PolicyDocumentBlock = { kind: "heading" | "paragraph" | "list_item" | "table_row"; text: string; level?: number; sourceBlockId?: string }`.
- Keep `FeishuPolicyDocumentClient.read(locator): Promise<ReadPolicyDocument>`; Wiki resolves to Docx first.

- [x] **Step 1: Write failing tests** for paginated block retrieval, heading level, nested document order, list/table text, and authorization/unsupported-content failures. Assert the long-text block tail survives extraction.
- [x] **Step 2: Run tests** with `npx vitest run tests/unit/infrastructure/feishu-policy-document-client.test.ts`; expect the new tests to fail.
- [x] **Step 3: Implement the reader** using the official paginated Docx block endpoint; preserve heading and textual block structure, classify errors safely, and reject material text that cannot be represented. Keep raw-content-only fixtures as a conservative compatibility path only when headings are explicit.
- [x] **Step 4: Run the focused tests**; expect PASS, then commit the reader and tests.

### Task 2: Section builder and atomic search chunks

**Files:**
- Create: `src/application/build-policy-sections.ts`
- Modify: `src/application/split-policy-document.ts`
- Test: `tests/unit/application/build-policy-sections.test.ts`
- Test: `tests/unit/application/split-policy-document.test.ts`

**Interfaces:**
- Produce `buildPolicySections(blocks: PolicyDocumentBlock[]): PolicySectionDraft[]`, where `PolicySectionDraft = { sequence: number; headingPath: string[]; content: string; sourceAnchor: string | null; complete: boolean }`.
- Produce `splitPolicyDocument(sections: PolicySectionDraft[], options: { targetLength: number; maxLength: number }): PolicyChunkDraft[]`, with each chunk carrying `sectionSequence`, ordered `sequence`, `content`, and `sourceAnchor`.

- [x] **Step 1: Write failing tests** for lodging rules: 600/500/400 and exception lines remain ordered in their heading-path sections so retrieval can reconstruct the topic family; traffic stays separate; one long paragraph is never reduced to its first 500 characters; oversized sections retain explicit incompleteness.
- [x] **Step 2: Run the focused tests**; expect FAIL.
- [x] **Step 3: Implement title-level boundaries and 400–800-character search chunks** without splitting a single rule, list item or table row; use the source block identifier when available.
- [x] **Step 4: Run both focused test files**; expect PASS, then commit the builder, splitter and tests.

### Task 3: Versioned section snapshots and safe resync

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_policy_sections_v2/migration.sql`
- Modify: `src/infrastructure/prisma/policy-knowledge-repository.ts`
- Modify: `src/application/sync-policy-source.ts`
- Test: `tests/unit/application/sync-policy-source.test.ts`
- Test: `tests/integration/policy-knowledge-repository.test.ts`

**Interfaces:**
- Add `PolicySection` with snapshot relation, sequence, heading path, complete body and completeness flag; add nullable `PolicyChunk.sectionId` for legacy rows.
- Add `PolicyDocumentSnapshot.indexVersion` default `1`; unique key becomes `(sourceId, sourceRevision, indexVersion)`.
- Repository `getLatestIndexState(sourceId): Promise<{ contentHash: string; indexVersion: number } | null>` and `stageSnapshot({ ..., indexVersion: 2, sections, chunks })` transactionally link chunks to their section.

- [x] **Step 1: Write failing tests** for v1-to-v2 reindex with unchanged content, v2 unchanged skip, section/chunk persistence, active-only search, and failed embedding retaining the old active snapshot.
- [x] **Step 2: Run focused unit tests**; expect FAIL. Apply the additive migration to the test database using `npm run db:test:migrate`; verify old rows survive.
- [x] **Step 3: Implement schema/repository/sync changes**; hash canonical extracted content, batch embeddings at the existing limit, stage everything before activation, and return `{ status, sectionCount, chunkCount }` from the worker operation.
- [x] **Step 4: Run focused unit and integration tests**; expect PASS, then commit migration, repository, sync and tests.

### Task 4: Section expansion and separated answer evidence

**Files:**
- Modify: `src/application/search-policy-knowledge.ts`
- Modify: `src/infrastructure/prisma/policy-knowledge-repository.ts`
- Modify: `src/application/run-conversation-turn.ts`
- Modify: `src/application/run-agent-turn.ts`
- Modify: `src/infrastructure/model/openai-compatible-chat-model.ts`
- Modify: `src/worker/feishu-bot.ts`
- Modify: `app/api/conversations/private/messages/route.ts`
- Modify: `app/api/claims/[claimId]/chat/route.ts`
- Test: `tests/unit/application/search-policy-knowledge.test.ts`
- Test: `tests/unit/application/run-conversation-turn.test.ts`
- Test: `tests/unit/infrastructure/openai-compatible-chat-model.test.ts`

**Interfaces:**
- `searchPolicyKnowledge(...)` returns `PolicySearchResult = { evidence: Array<{ sectionId: string; title: string; headingPath: string[]; text: string; complete: boolean }>; citations: PolicyCitation[]; incomplete: boolean }`.
- Repository `searchChunks({ vector, limit })` returns active candidate chunks with `sectionId`; `loadSections(sectionIds: string[])` returns full matched sections and `loadSectionFamily(sectionId, headingPrefix)` returns related active sections in source order. Legacy chunks have an explicit fallback without a false completeness claim.
- All policy-answer call sites pass `evidence` to the model and persist/display only `citations`.

- [x] **Step 1: Write failing tests** for broad lodging question yielding all three rates across subordinate headings, two matching chunks expanding only once, unrelated traffic exclusion, >500-character tail available to the model, three-family/8,000-character budget, and incomplete or no-hit safe reply.
- [x] **Step 2: Run focused tests**; expect FAIL.
- [x] **Step 3: Implement vector-hit grouping and complete-topic-family expansion** (12 candidate chunks, at most three selected families), plus short exact citations; update both conversation paths and model prompt so a partial evidence set never sounds exhaustive.
- [x] **Step 4: Run focused tests and related conversation tests**; expect PASS, then commit retrieval and answer changes.

### Task 5: Admin status, full regression and local acceptance

**Files:**
- Modify: `app/api/admin/policy-sources/route.ts`
- Modify: `src/server/policy-source-response.ts`
- Modify: `src/ui/policy-source-manager.tsx`
- Test: `tests/integration/api/policy-source-routes.test.ts`
- Test: `tests/unit/ui/policy-source-manager.test.ts`
- Test: `tests/integration/async-policy-sync-flow.test.ts`
- Modify: `docs/superpowers/specs/2026-10-25-section-aware-policy-retrieval-design.md` only if implementation discovered a documented constraint change

**Interfaces:**
- GET policy source response includes nullable `sectionCount` and `chunkCount` from its active snapshot; the async sync POST remains HTTP 202 with job identity only.

- [x] **Step 1: Write failing API/UI tests** for counts becoming visible only after active snapshot switch and safe parse-failure status; test stale counts remain the last successful counts after a failed job.
- [x] **Step 2: Run focused tests**; expect FAIL.
- [x] **Step 3: Implement the existing admin source-row display** without a new page or a premature “sync complete” message.
- [x] **Step 4a: Run `npm test`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`**; latest rerun passed 413 tests, lint had 0 errors and 2 unrelated existing warnings, types and build passed. The additive and corrective migrations are applied to the local development and test databases.
- [ ] **Step 4b: Complete live acceptance.** Authorized-source v2 resync succeeded after the embedded sheet was replaced with an ordinary document table. Direct retrieval checks passed for broad and city-specific lodging questions with all three rate tiers present. The user confirmed Feishu manual answer validation; separate Web answer validation remains unconfirmed.
- [x] **Step 5: Review the full diff for secrets, policy-answer regressions and migration safety; commit final tests/UI/docs.**
