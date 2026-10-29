# Go Policy and Agent Answer Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Go enforce its published structured policy and make Agent describe document answers as evidence rather than a submit verdict.

**Architecture:** Keep Go as sole policy decision owner. Persist validated rules with each Go policy version, read the active version during validation, and recheck under a transaction at submit. Retain Feishu document retrieval for cited explanations.

**Tech Stack:** Go, pgx/PostgreSQL, TypeScript/Vitest, existing Go HTTP API.

**Spec:** `docs/superpowers/specs/2026-10-28-policy-go-agent-consistency-design.md`

## Task 1: Go policy model and persistence

- [x] Add failing tests for valid/invalid publish configurations and rule evaluation.
- [x] Add `000015` migration for version rules and repository read/publish operations.
- [x] Run focused Go tests and confirm pass.

## Task 2: Validation and transactional submission

- [x] Add failing tests for blocking/warning rules, active version, changed-version confirmation, and transaction recheck.
- [x] Wire active policy into Go validation and transaction. Preserve idempotent replay.
- [x] Run Go unit and repository tests with available isolated test database.

## Task 3: Agent wording and API contract

- [x] Add failing Agent test for document answer disclaimer and version/citation boundary.
- [x] Update answer wording and Go validation response with rule identifiers.
- [x] Update API/admin documentation for supported rule types and unavailable city/detail rules.

## Task 4: Verification

- [x] Run Go tests, TypeScript tests, typecheck/build, inspect diff, and document any environment-only verification still required.

Verification: Go `go test ./...` passed against an isolated pgvector PostgreSQL database after applying all 15 migrations, including the policy submission and saved-warning readback integration test; root Vitest passed 501 tests; React Vitest passed 49 tests and Vite build passed; React TypeScript typecheck and root lint passed (two existing Hook dependency warnings). The local Go API and React containers were rebuilt, and the edge served the new asset bundle. A live Feishu OAuth end-to-end run remains an environment check.

## Review Focus

- Policy publication racing with submission.
- Future-effective versions with no active policy.
- Invalid/unknown rules failing closed.
- Rule warnings not blocking.
- Agent never claiming the document was enforced.
