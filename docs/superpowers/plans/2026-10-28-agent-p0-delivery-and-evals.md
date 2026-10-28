# Agent P0 Reply Delivery and Intent Evaluation Implementation Plan

**Goal:** Preserve every completed Feishu turn's reply until delivery succeeds or reaches an observable terminal failure, and make intent evaluation cover the current action and target surface.

**Architecture:** The inbound event row owns two stages: business processing and outbound reply delivery. The business stage persists the exact reply before it can be acknowledged; the delivery stage claims that reply independently and uses a stable Feishu `uuid` to deduplicate retries. A bounded retry schedule and terminal status are visible through structured logs and an alert. The offline intent evaluator checks both action and safety-critical decision fields against versioned anonymous cases; it never calls reimbursement tools.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Vitest, Feishu message API, Loki.

## Constraints

- Keep the current checkout; do not create a worktree.
- Do not log reply text, user messages, or model credentials.
- Keep the existing exact-text submission confirmation and Go authorization boundary.
- Do not call the real model during automated tests.

## Task 1: Durable Feishu reply delivery

- [x] Add failing runtime and repository tests for a failed send, restart recovery, stable `uuid`, and terminal failure.
- [x] Add the inbound delivery states and fields in Prisma, with a migration.
- [x] Persist the reply before delivery; independently claim and retry delivery without rerunning the business turn.
- [x] Add delivery lifecycle logs and a Loki alert; test the Feishu client request body.
- [x] Run focused tests, typecheck, lint, and migration checks.

## Task 2: Current-surface intent evaluation

- [x] Add failing dataset and evaluator tests requiring every current intent action and checking target or search arguments for risky cases.
- [x] Add anonymous dev and locked holdout cases for search, pagination, selection, deletion, progress, and cross-channel references.
- [x] Report action accuracy separately from decision-argument accuracy and dangerous write-target errors; fail the CLI gate on a full holdout regression.
- [x] Document how to add consented, de-identified self-test phrases without mixing them into the locked holdout.
- [x] Run fixture tests and the full local test/build checks without contacting the model provider.

Live model scoring remains unverified: the configured endpoint was blocked by the local network sandbox (`EACCES`), and automatic escalation review rejected sending these dataset samples to the external model without explicit destination/sample authorization. Do not describe fixture success as a real-model score.

## Review focus

- A send that succeeds remotely but times out locally must not create a duplicate within the Feishu deduplication window.
- A worker restart after persisting a reply must not execute the reimbursement action again.
- Repeated provider failures must leave an operator-visible terminal record.
- A model choosing the right action but a different claim number must fail evaluation.
- Ambiguous or negative submit requests must never be scored as safe submission preparation.
