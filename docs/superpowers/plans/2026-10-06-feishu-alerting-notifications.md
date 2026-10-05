# 飞书告警通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Loki Ruler 的运行告警经 Alertmanager 聚合、脱敏并投递到专用飞书告警群。

**Architecture:** Loki Ruler 只将规则状态发送给 Docker 内网 Alertmanager；Alertmanager 负责分组、抑制、去重和重试，并向不公开端口的 `alert-relay` 发标准 webhook。`alert-relay` 使用纯函数将允许字段转为飞书卡片，再使用唯一的环境变量 Webhook 地址投递。

**Tech Stack:** Docker Compose、Grafana Loki 3.2.1、Prometheus Alertmanager、Node.js 24、TypeScript、Zod、Vitest、飞书群机器人 Webhook。

**Spec:** `docs/superpowers/specs/2026-10-06-feishu-alerting-notifications-design.md`

## Global Constraints

- 只允许 Docker 内网连接；不得为 Loki、Grafana、Alertmanager 或 `alert-relay` 添加 `ports` 映射。
- `FEISHU_ALERT_WEBHOOK_URL` 只能来自 `.env.local` 或生产 Secret，禁止出现在代码、Compose、日志、测试快照或 Git 历史中。
- 飞书卡片和日志不得包含票据、会话、原始日志、对象键、员工身份、请求/任务 ID、堆栈或凭据。
- `alert-relay` 缺少或格式错误的 Webhook 配置必须启动失败；应用与业务 Worker 不受影响。
- 本阶段不创建飞书群、不配置真实 Webhook、不开放运维域名，也不修改现有告警阈值。

## Review Focus

- 含未知或敏感 label/annotation 的 Alertmanager 负载必须被忽略，不能进入飞书卡片；Task 1 覆盖。
- 同一 webhook 批次的 firing 与 resolved 状态必须分别展示，不能把恢复误报为故障；Task 1 覆盖。
- 飞书返回非 2xx 或请求超时时 Relay 必须返回 502，使 Alertmanager 能重试；Task 2 覆盖。
- 空、非 HTTPS 或非飞书域名的 Webhook 值必须阻止 Relay 启动；Task 2 覆盖。
- Compose 中任何观察性服务意外暴露主机端口都会破坏隔离边界；Task 3 覆盖。

---

## File Structure

- `src/server/alert-relay-config.ts`：读取并验证 Relay 的运行环境配置。
- `src/observability/alert-relay.ts`：解析 Alertmanager 负载、过滤安全字段、渲染飞书交互式卡片的纯函数。
- `src/worker/alert-relay.ts`：Node HTTP 运行入口、健康检查、飞书 HTTP 投递与结构化日志。
- `observability/alertmanager.yml`：Alertmanager 路由、接收器、抑制及重试配置。
- `observability/loki-config.yml`：Loki Ruler 到 Docker 内网 Alertmanager 的地址。
- `docker-compose.yml`：`alertmanager` 与 `alert-relay` 的 observability profile 服务定义。
- `.env.example`、`docs/operations.md`：安全配置、启动、验收与回滚说明。
- `tests/unit/server/alert-relay-config.test.ts`：配置边界测试。
- `tests/unit/observability/alert-relay.test.ts`：纯负载与卡片转换测试。
- `tests/unit/worker/alert-relay.test.ts`：HTTP 入口、飞书成功/失败/超时行为测试。
- `tests/integration/observability-alerting-compose.test.ts`：Compose、Loki 与 Alertmanager 配置契约测试。

### Task 1: 安全的告警负载与飞书卡片转换

**Files:**
- Create: `src/observability/alert-relay.ts`
- Modify: `src/observability/logger.ts`
- Test: `tests/unit/observability/alert-relay.test.ts`
- Test: `tests/unit/observability/logger.test.ts`

**Interfaces:**
- Consumes: Alertmanager v4 webhook JSON 负载。
- Produces: `parseAlertmanagerWebhook(value: unknown): AlertBatch | null` 与 `renderFeishuAlertCard(batch: AlertBatch): FeishuCard`，供 Task 2 HTTP 服务调用。

- [ ] **Step 1: 写入卡片转换失败测试**

```ts
it("renders only approved firing fields and excludes sensitive labels", () => {
  const batch = parseAlertmanagerWebhook({
    status: "firing",
    alerts: [{
      status: "firing",
      labels: { alertname: "JobWorkerHeartbeatMissing", severity: "critical", service: "job-worker", claimId: "secret" },
      annotations: { summary: "异步任务 Worker 已超过 5 分钟没有心跳", internal: "secret" },
      startsAt: "2026-10-06T00:00:00.000Z",
    }],
  });
  expect(renderFeishuAlertCard(batch!)).toMatchObject({ msg_type: "interactive" });
  expect(JSON.stringify(renderFeishuAlertCard(batch!))).not.toContain("secret");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/observability/alert-relay.test.ts`
Expected: FAIL，因为模块尚不存在。

- [ ] **Step 3: 实现负载和卡片纯函数**

在 `src/observability/alert-relay.ts` 定义 `AlertItem`、`AlertBatch`、`FeishuCard`；只接受 `alertname`、`severity`、`service`、`summary`、`startsAt`、`endsAt` 和状态。卡片标题固定为“AI 报销系统告警”或“AI 报销系统告警已恢复”，并显示数量、每条安全摘要与时间。

- [ ] **Step 4: 扩展日志服务类型并补充测试**

将 `LogService` 扩展为包含 `"alert-relay"`，保持既有字段白名单不扩大；验证未知日志字段仍被删除。

- [ ] **Step 5: 运行相关单元测试确认通过**

Run: `npm test -- tests/unit/observability/alert-relay.test.ts tests/unit/observability/logger.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交 Task 1**

```powershell
git add src/observability/alert-relay.ts src/observability/logger.ts tests/unit/observability/alert-relay.test.ts tests/unit/observability/logger.test.ts
git commit -m "feat: render safe Feishu alert cards"
```

### Task 2: Relay 配置与 HTTP 投递运行时

**Files:**
- Create: `src/server/alert-relay-config.ts`
- Create: `src/worker/alert-relay.ts`
- Modify: `package.json`
- Test: `tests/unit/server/alert-relay-config.test.ts`
- Test: `tests/unit/worker/alert-relay.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseAlertmanagerWebhook`、`renderFeishuAlertCard` 和 `createLogger`。
- Produces: `readAlertRelayConfig(env): AlertRelayConfig`、`createAlertRelayServer(options)`；`npm run alert:relay:container` 可作为 Compose 命令启动。

- [ ] **Step 1: 写入配置校验失败测试**

```ts
expect(() => readAlertRelayConfig({})).toThrow("FEISHU_ALERT_WEBHOOK_URL is required");
expect(() => readAlertRelayConfig({ FEISHU_ALERT_WEBHOOK_URL: "http://open.feishu.cn/open-apis/bot/v2/hook/x" })).toThrow();
expect(readAlertRelayConfig({ FEISHU_ALERT_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/x" })).toMatchObject({ port: 8082 });
```

- [ ] **Step 2: 写入 HTTP 行为失败测试**

用注入的 `fetch` 和 `createLogger` fake 覆盖：`GET /health` 返回 200；非法方法/负载返回 405/400；飞书 2xx 返回 200；飞书非 2xx 或超时返回 502；日志与响应均不包含 Webhook 或敏感标签。

- [ ] **Step 3: 运行新增测试确认失败**

Run: `npm test -- tests/unit/server/alert-relay-config.test.ts tests/unit/worker/alert-relay.test.ts`
Expected: FAIL，因为配置和运行入口尚不存在。

- [ ] **Step 4: 实现 `readAlertRelayConfig`**

实现 `readAlertRelayConfig(env: NodeJS.ProcessEnv): AlertRelayConfig`。默认端口为 `8082`；要求 Webhook 为 `https:`、主机为 `open.feishu.cn` 且路径以 `/open-apis/bot/v2/hook/` 开头。错误信息只描述配置名和格式，不回显值。

- [ ] **Step 5: 实现 `createAlertRelayServer` 与 Worker 入口**

实现 `createAlertRelayServer(options: AlertRelayServerOptions): http.Server`。仅接收 `POST /alertmanager`，限制 JSON body 为 256 KiB，调用 Task 1 纯函数并向配置 URL 发 JSON。飞书失败或异常统一返回 502；安全日志使用事件 `alert.delivery.completed`、`alert.delivery.failed` 和允许字段 `count`、`status`、`durationMs`、`failureCode`。在 Worker 入口读取配置并监听端口；向 `package.json` 新增 `alert:relay:container`。

- [ ] **Step 6: 运行 Task 2 测试确认通过**

Run: `npm test -- tests/unit/server/alert-relay-config.test.ts tests/unit/worker/alert-relay.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交 Task 2**

```powershell
git add src/server/alert-relay-config.ts src/worker/alert-relay.ts package.json tests/unit/server/alert-relay-config.test.ts tests/unit/worker/alert-relay.test.ts
git commit -m "feat: add Feishu alert relay runtime"
```

### Task 3: 连接 Loki、Alertmanager 与 Docker 服务

**Files:**
- Create: `observability/alertmanager.yml`
- Modify: `observability/loki-config.yml`
- Modify: `docker-compose.yml`
- Modify: `tests/integration/observability-compose.test.ts`
- Create: `tests/integration/observability-alerting-compose.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `npm run alert:relay:container`，固定监听 `8082`、`/health` 与 `/alertmanager`。
- Produces: `docker compose --profile observability up -d --build` 可启动完整、无主机端口的告警投递链路。

- [ ] **Step 1: 写入 Compose/配置契约失败测试**

```ts
expect(compose).toMatch(/alertmanager:[\s\S]*?profiles:\s*\["observability"\]/);
expect(compose).toMatch(/alert-relay:[\s\S]*?profiles:\s*\["observability"\]/);
expect(compose).not.toMatch(/alertmanager:[\s\S]*?\n    ports:/);
expect(compose).not.toMatch(/alert-relay:[\s\S]*?\n    ports:/);
expect(loki).toContain("alertmanager_url: http://alertmanager:9093");
expect(alertmanager).toContain("group_wait: 30s");
expect(alertmanager).toContain("repeat_interval: 4h");
```

- [ ] **Step 2: 运行配置契约测试确认失败**

Run: `npm test -- tests/integration/observability-compose.test.ts tests/integration/observability-alerting-compose.test.ts`
Expected: FAIL，因为 Alertmanager 与 Relay 尚未定义。

- [ ] **Step 3: 新增 Alertmanager 配置**

创建 `observability/alertmanager.yml`：默认路由按 `alertname`、`service`、`severity` 分组，使用 30 秒/5 分钟/4 小时窗口；webhook receiver 指向 `http://alert-relay:8082/alertmanager` 并设置 `send_resolved: true`；定义 `critical` 抑制同名同服务 `warning` 的规则。

- [ ] **Step 4: 配置 Loki Ruler 与 Compose 服务**

在 `ruler` 配置加入 `alertmanager_url: http://alertmanager:9093`。在 Compose 中新增 `quay.io/prometheus/alertmanager:v0.28.1`（挂载只读配置、`expose: 9093`）和 Relay（复用项目 Dockerfile、`app_env` Secret、`npm run alert:relay:container`、`expose: 8082`、无 `ports`）；Relay `/health` 成功后再启动 Alertmanager。两个服务均属于 `observability` profile，设置适度内存限制和 `unless-stopped` 重启策略。

- [ ] **Step 5: 运行配置契约测试确认通过**

Run: `npm test -- tests/integration/observability-compose.test.ts tests/integration/observability-alerting-compose.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交 Task 3**

```powershell
git add observability/alertmanager.yml observability/loki-config.yml docker-compose.yml tests/integration/observability-compose.test.ts tests/integration/observability-alerting-compose.test.ts
git commit -m "feat: route observability alerts to relay"
```

### Task 4: 安全配置、运维文档与端到端验证

**Files:**
- Modify: `.env.example`
- Modify: `docs/operations.md`
- Modify: `docs/architecture.md`
- Modify: `tests/integration/observability-alerts.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 的环境变量、Compose profile 和 HTTP 端点。
- Produces: 管理员可不暴露凭据地部署、检查、演练与回滚告警投递链路。

- [ ] **Step 1: 写入文档/安全约束失败测试**

扩展现有 observability 测试，断言 `.env.example` 只有空 `FEISHU_ALERT_WEBHOOK_URL`、操作文档包含 Alertmanager/Relay 启动与无害演练命令、并明确没有固定域名时不发送 Grafana 外链。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/integration/observability-alerts.test.ts`
Expected: FAIL，因为部署文档和示例变量尚未更新。

- [ ] **Step 3: 更新示例配置与运维/架构文档**

在 `.env.example` 添加空的 `FEISHU_ALERT_WEBHOOK_URL`。文档说明建立专用告警群、将值写入未提交 Secret、启动 `docker compose --profile observability up -d --build`、检查 Relay/Alertmanager 健康、使用测试规则演练、查看失败日志及安全回滚。禁止文档要求用户贴出 Webhook；明确当前不含外部 Grafana 链接。

- [ ] **Step 4: 运行 Task 4 测试确认通过**

Run: `npm test -- tests/integration/observability-alerts.test.ts`
Expected: PASS。

- [ ] **Step 5: 执行全量静态与测试验证**

Run: `npx tsc --noEmit; npm test`
Expected: TypeScript 退出码 0；Vitest 全部通过。

- [ ] **Step 6: 验证 Compose 配置可解析且不开放端口**

Run: `docker compose --profile observability config`
Expected: 配置解析成功；普通 profile 不依赖 Alertmanager/Relay；Alertmanager 与 Relay 没有主机 `ports`。缺少 Webhook 的运行时失败已由 Task 2 配置单元测试覆盖。

- [ ] **Step 7: 提交 Task 4**

```powershell
git add .env.example docs/operations.md docs/architecture.md tests/integration/observability-alerts.test.ts
git commit -m "docs: document Feishu alerting operations"
```
