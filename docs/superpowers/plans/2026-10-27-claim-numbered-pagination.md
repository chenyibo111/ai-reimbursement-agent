# 报销单页码分页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 员工报销单列表支持每页 10 条及直接跳页，并保留 Agent 游标查询。

**Architecture:** Go 查询对象增加可选 `Page`，内存与 PostgreSQL 仓储按稳定排序分页。React 列表用 URL 页码和单页查询，API 类型、OpenAPI 与 UX 合同同步更新。

**Tech Stack:** Go、PostgreSQL、React、TanStack Query、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-27-claim-numbered-pagination-design.md`

## Global Constraints

- Web 每页固定 10 条；Go 页码范围 1–10000。
- 不改变无 `page` 的 Agent 游标查询行为。
- 保持现有中文设计和本人数据隔离。

## Review Focus

- 页码与游标混用应返回 400；页码 0、负数、超上限应返回 400。
- 第 11 页应能读取第 101 条，同时不读取其他员工单据。
- 改筛选条件、清除筛选、浏览器后退和无效 URL 页码应落在正确页。
- 页码超出筛选后的总页数应回退，不显示永久空白。
- 页码切换失败应保留筛选并可重试。

---

### Task 1: Go 页码查询

**Files:** `services/reimbursement-api/internal/application/claim_search.go`、`claim_service.go`、`internal/store/claim_repository.go`、`internal/transport/http/claims_handler.go` 及对应测试，`api/openapi/reimbursement-v1.yaml`。

**Interfaces:** `SearchClaimsQuery.Page int`；`page` 查询参数为 1–10000；页码模式返回空 `nextCursor`。

- [x] 先写服务、HTTP 和数据库仓储测试，并确认新测试失败。
- [x] 实现解析、校验、内存与 PostgreSQL OFFSET 查询。
- [x] 跑 Go 测试并更新 OpenAPI。

### Task 2: React 页码交互

**Files:** `apps/web/src/routes/claims-list-page.tsx` 及测试、`features/claims/use-claim.ts`、`api/generated/reimbursement.ts`、`api/client.test.ts`、`styles.css`、`UX-CONTRACT.md`。

**Interfaces:** `ClaimSearchQuery.page?: number`；`useClaims` 返回单页查询结果。

- [x] 先写页码跳转、筛选重置及 URL 状态测试，确认失败。
- [x] 实现页码控件、查询与可恢复的加载和错误状态。
- [x] 跑 Web 测试与构建，更新 UX 合同。

### Task 3: 综合验证

- [x] 运行相关 Go、Web、根目录合同测试及构建。
- [x] 复核 diff 与 Agent 游标兼容性。

验证记录：Go `go test ./...`（隔离 PostgreSQL）通过；Web 42 个测试、类型检查和构建通过；根目录 OpenAPI 与路由合同测试通过。根目录全量 `npm test` 在受限沙箱中因无法连接本机 PostgreSQL 和临时 HTTP 端口而失败，错误为 `connect EACCES 127.0.0.1`。两个本机容器已重建；`/claims` 返回 200，未登录的页码 API 请求返回 401。
