# 可观测日志平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Grafana、Loki 和 Alloy 为应用与异步任务提供安全、可查询、可告警的结构化日志平台，并预留 OpenTelemetry 关联边界。

**Architecture:** 应用统一输出脱敏 JSON 到 stdout；Alloy 读取 Docker 容器日志，解析低基数标签后写入 Loki；Grafana 提供 Explore、仪表盘和告警。PostgreSQL 业务审计不迁移到日志平台，任务中心提供 `jobId` 链路字段。

**Tech Stack:** Next.js/TypeScript、Docker Compose、Grafana、Loki、Grafana Alloy、LogQL；后续 OpenTelemetry Collector/Tempo。

**Spec:** `docs/superpowers/specs/2026-09-28-observability-logs-design.md`

## Global Constraints

- 此计划在异步任务中心完成后执行；`jobId` 由该计划的任务表提供。
- 日志、配置、仪表盘和告警不得记录或暴露对象键、附件内容、token、Cookie、open_id、完整 OCR 数据、模型提示词或原始请求体。
- Loki label 只能使用低基数维度：`service`、`environment`、`level`、`event`、`jobKind`。
- Grafana/Loki 不映射公共端口；Alloy 的 Docker socket 只读挂载且仅存在于观测容器。
- 完整业务事实继续由 PostgreSQL 审计/任务表保存；日志留存固定为 30 天。

## Review Focus

- 用户输入或 OCR 原文意外进入日志：白名单序列化器必须丢弃未知字段（Task 1）。
- 高基数 `jobId`/`claimId` 被设为 Loki label：Alloy 配置只提取指定低基数字段（Task 2）。
- Grafana/Loki 暴露到公网：Compose 不含 `ports` 映射，反向代理之外没有直连入口（Task 2）。
- Worker 无任务时没有可见心跳：固定周期安全心跳事件仍进入日志（Task 3）。
- 告警只在单次错误时泛滥：规则包含窗口、最小样本和持续时间（Task 4）。

---

### Task 1: 应用结构化日志与关联 ID

**Files:**
- Create: `src/observability/logger.ts`
- Create: `src/observability/request-context.ts`
- Modify: `app/api/**/route.ts`（通过共享包装器接入）
- Modify: `src/worker/feishu-bot.ts`
- Modify: `src/worker/job-worker.ts`
- Modify: `ocr-service/**`
- Test: `tests/unit/observability/logger.test.ts`
- Test: `tests/integration/api/request-correlation.test.ts`

**Interfaces:**
- Consumes async job `jobId` 与安全失败码。
- Produces `createLogger(service)`, `withRequestContext`, `logJobEvent`，输出单行 JSON。

- [ ] Write failing tests for stable JSON fields, `x-request-id` propagation, `jobId` correlation and secret-field removal.
- [ ] Run `npm test -- --run tests/unit/observability/logger.test.ts tests/integration/api/request-correlation.test.ts` and verify failure.
- [ ] Implement allowlisted logger/context wrappers; replace direct `console.log/error` in the owned services.
- [ ] Rerun focused tests; expect PASS.
- [ ] Commit `feat: add structured application logging`.

### Task 2: Loki、Alloy、Grafana Compose 基础设施

**Files:**
- Modify: `docker-compose.yml`
- Create: `observability/loki-config.yml`
- Create: `observability/config.alloy`
- Create: `observability/grafana/provisioning/datasources/loki.yml`
- Create: `observability/grafana/provisioning/dashboards/dashboards.yml`
- Test: `tests/integration/observability-compose.test.ts`

**Interfaces:**
- Consumes Task 1 stdout JSON contract.
- Produces Docker services `loki`, `alloy`, `grafana` and datasource `Loki`.

- [ ] Write failing Compose assertion that services, read-only socket mount, 30-day retention, low-cardinality relabel rules and absence of public Loki/Grafana `ports` exist.
- [ ] Run `docker compose config` and the test; verify failure.
- [ ] Implement single-node Loki/Alloy/Grafana configuration and persistent volumes.
- [ ] Rerun `docker compose config` and focused test; expect PASS.
- [ ] Commit `feat: add self-hosted log observability stack`.

### Task 3: Grafana 仪表盘与任务 Worker 健康事件

**Files:**
- Create: `observability/grafana/dashboards/job-runtime.json`
- Modify: `src/worker/job-worker.ts`
- Modify: `src/worker/feishu-bot.ts`
- Test: `tests/unit/worker/job-worker-observability.test.ts`
- Test: `tests/integration/grafana-dashboard-contract.test.ts`

**Interfaces:**
- Consumes JSON events from Task 1 and Compose datasource from Task 2.
- Produces dashboard panels for job lifecycle, OCR failures, worker heartbeat and web/Feishu errors.

- [ ] Write failing tests for heartbeat event, required dashboard LogQL fields and no sensitive query expansion.
- [ ] Run focused tests and verify failure.
- [ ] Implement stable heartbeat/lifecycle logging and provisioned dashboard JSON.
- [ ] Rerun focused tests; expect PASS.
- [ ] Commit `feat: add job runtime observability dashboard`.

### Task 4: Loki 告警规则、操作文档与 OpenTelemetry 预留

**Files:**
- Create: `observability/loki-rules.yml`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/architecture.md`
- Create: `src/observability/trace-context.ts`
- Test: `tests/integration/observability-alerts.test.ts`

**Interfaces:**
- Consumes dashboard/query fields from Tasks 1–3.
- Produces windowed alert rules and trace-field compatible log context without requiring Tempo deployment.

- [ ] Write failing assertions for the five initial alerts, duration/minimum-sample safeguards, 30-day runbook, protected access and OpenTelemetry-compatible `traceId/spanId` field handling.
- [ ] Run focused test and verify failure.
- [ ] Implement rules, documented notification integration points, runbook and no-op trace context boundary.
- [ ] Run `npm test`, `npm run build`, `docker compose config` and observability test suite; expect PASS.
- [ ] Commit `docs: document log observability operations`.

## Plan Self-Review

- Spec coverage: Tasks 1–4 cover logging contract, self-hosted collection/query, dashboards, alerts, retention, access restrictions and OpenTelemetry preparation.
- Type consistency: `jobId`, `requestId`, `traceId`, `spanId` remain payload fields from logger through Alloy, Loki and dashboard queries.
- Review focus: sensitive data, label cardinality, exposure, heartbeats and noisy alerts each have a specific task test.
- Scope: no ELK/OpenSearch migration, public Grafana access, long-term archival or trace backend deployment is introduced.
