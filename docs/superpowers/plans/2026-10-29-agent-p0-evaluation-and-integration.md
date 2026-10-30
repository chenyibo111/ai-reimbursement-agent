# Agent P0 评测与真实边界验收实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可重复的真实模型评测和隔离数据库上的飞书事件至 Go API 集成验收，补齐当前 Agent 发布证据。

**Architecture:** 保留现有会话编排和 Go 工具网关。评测扩充版本化案例，连续运行并汇总波动；集成测试使用真实 Prisma 仓储、真实 HTTP Go API 与真实飞书事件运行时，只替换飞书平台网络和模型响应，平台联调另按清单现场执行。

**Tech Stack:** TypeScript、Vitest、Prisma、PostgreSQL、Go API Docker 镜像、飞书长连接事件运行时。

**Spec:** 用户已选择先完成“扩充真实模型评测”和“真实链路验收”两个 P0；范围与验收理由见本轮对话。

## Global Constraints

- 开发在当前分支进行，不使用 worktree。
- 集成脚本只创建并删除带 `agent_p0_` 前缀的临时数据库；不得清理开发业务库或已有测试库。
- 案例只写匿名或合成内容；不能伪称合成案例是员工样本。
- 模型评测报告不得包含原始会话、票据、密钥或模型回复全文。
- 飞书平台与 OAuth 的真正联调需要有效账号和可访问的固定 HTTPS 地址，自动测试不能伪称覆盖它。

## Review Focus

- 连续运行中某轮失败：总门槛失败，且输出指出失败轮次与案例。
- 某轮工具误写或误目标：安全错误汇总为非零，门槛失败。
- 仅抽样案例：无论重复多少次，都不报告完整门槛通过。
- 飞书重复事件：同一消息只写一次会话，只发送一次回复。
- 员工越权查询：Go API 返回安全结果，不泄露另一员工的数据。

---

### Task 1: 版本化多轮场景与稳定性门槛

**Files:** `src/application/evaluate-agent-workflow.ts`、`scripts/eval-agent-workflow.ts`、`tests/fixtures/agent-workflow/workflow-v2.jsonl`、`tests/unit/application/evaluate-agent-workflow.test.ts`、`tests/integration/agent-workflow-eval.test.ts`、`docs/operations/agent-intent-evaluation.md`

- [x] 写稳定性汇总的失败测试，验证中间轮失败、安全错误与抽样不通过完整门槛。
- [x] 运行测试，确认按预期失败。
- [x] 实现 `--repeat N` 顺序重放、汇总及稳定性门槛；报告仍不包含原文。
- [x] 扩充场景为 v2，加入多轮选单、编辑、取消提交、越权和政策追问；保留准确来源标记。
- [x] 运行固定模式全量回放和真实模型完整重复评测，记录实际结果。

### Task 2: 飞书事件至 Go HTTP 的隔离集成验收

**Files:** `tests/integration/agent-live-go-feishu-flow.test.ts`、`scripts/run-agent-live-integration.ts`、`package.json`、`docs/operations/agent-live-integration.md`

- [x] 写集成测试，使用独立测试库、真实飞书事件运行时与 Go API HTTP；检查创建/查询/确认边界、持久化和事件去重。
- [x] 运行显式入口，确认 Docker 连接失败会报错而非报告通过；普通 `npm test` 在未提供测试环境时跳过该专用测试。
- [x] 实现可重复的本地启动与清理脚本，只对隔离测试数据库写入。
- [x] 运行集成测试并检查数据库状态；补现场飞书平台验收清单及证据记录格式。

### Task 3: 最终复核

- [x] 运行 `npm test`、`npm run lint`、`npx tsc --noEmit` 和相关构建。
- [x] 检查 diff、数据库清理范围及文档命令，记录未覆盖的外部边界。

## 验证记录（2026-10-29）

- 固定决策工作流：18 个案例、21 轮，连续三次全通过，安全错误 0。
- 真实模型工作流：18 个案例、21 轮，连续三次全通过，模型错误 0，安全错误 0。
- 隔离飞书事件至 Go HTTP 测试：通过；结束后检查不到 `agent_p0_` 数据库和临时 Go 容器。
- `npm test`：520 通过、1 个需显式现场环境的测试跳过；`npx tsc --noEmit`、`npm run build` 通过；lint 为 0 错误、2 条既有的 React Hook 警告。
- 本地飞书 Worker 曾因开发库缺少 `20261028010000_feishu_reply_delivery` 迁移而反复重启；已运行 `prisma migrate deploy`，随后确认迁移状态为最新，Worker 日志出现 `worker.started`、`worker.heartbeat`，容器持续运行。未发送真实飞书消息。
- 尚未现场执行真实飞书长连接、真实票据 OCR/MinIO、知识库及双员工 OAuth 链路；这些步骤列于 `docs/operations/agent-live-integration.md`，不得以自动测试代替。
