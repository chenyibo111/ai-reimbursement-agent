# 可观测日志平台设计

## 1. 目标与范围

为 AI 报销 Agent 建设可自托管、可查询、可告警的运行日志平台。第一阶段采用 Grafana、Loki 和 Grafana Alloy 收集 Docker 容器的结构化日志；第二阶段在任务中心稳定后通过 OpenTelemetry 将日志、指标与链路追踪关联。

本设计依赖 `2026-09-28-async-jobs-and-review-center-design.md` 已完成，以 `jobId` 作为异步链路的核心关联字段。

本期包含：

- Web、飞书 Worker、任务 Worker、OCR 服务的统一脱敏 JSON 日志；
- Docker Compose 自托管 Grafana、Loki、Alloy；
- Grafana 中的日志查询、任务运行、OCR 失败和 Worker 存活仪表盘；
- 基于 Loki 查询的任务积压与高失败率告警；
- OpenTelemetry 作为后续 trace/metric 扩展边界。

本期不包含：

- 向公网暴露 Grafana 或 Loki；
- 收集附件二进制、对象键、token、Cookie、完整 OCR 原文、模型提示词或政策全文；
- ELK/OpenSearch、SIEM、长期冷归档、跨地域日志复制；
- 替代 PostgreSQL 中的 `AuditEvent`、`AsyncJob` 与 `ReviewCase` 业务审计记录。

## 2. 设计原则

- **业务审计与运行日志分离。** PostgreSQL 业务记录是可追溯事实；Loki 是可过期、可检索的运行诊断信息。
- **默认脱敏。** 日志只保存安全标识、状态、耗时、数量和安全失败码；敏感正文必须显式白名单后才可记录。
- **可关联而非可识别。** `requestId`、`jobId`、`claimId`、`receiptId` 与 `eventId` 用于检索；禁止记录员工姓名、手机号、飞书 open_id、票据文本和凭据。
- **标签低基数。** Loki 标签仅使用 `service`、`environment`、`level`、`event` 和 `jobKind`；`jobId`、`claimId` 等高基数字段位于 JSON 日志正文，通过 LogQL 解析检索。
- **平台私有。** Grafana 和 Loki 不映射公共端口；仅反向代理、VPN 或受控运维网络能访问 Grafana。

## 3. 架构

```text
web / feishu-bot-worker / job-worker / ocr
             │ stdout JSON
             ▼
      Grafana Alloy（Docker 发现、字段清洗、标签）
             ▼
            Loki ───────────────► Grafana Explore / Dashboards / Alerts
             ▲
             └── Docker 容器元数据（服务名、环境）
```

Alloy 通过 Docker socket 发现容器并读取 stdout/stderr。它解析 JSON、丢弃不允许的字段、添加 `service` 与 `environment` 标签，再写入 Loki。Loki 使用本地 Docker volume 做单节点存储；生产数据保留 30 天，容量增长后再评估 MinIO/S3 后端。

后续 OpenTelemetry 扩展：Node Web/Worker 进程向 OpenTelemetry Collector 发出 trace、metric 和关联日志；Collector 可继续把日志发送 Loki，并将 trace 发送 Grafana Tempo。现有 JSON 字段命名遵循 OpenTelemetry 语义：`traceId`、`spanId`、`service.name`、`error.type`、`durationMs`。

## 4. 日志契约

每条应用日志都必须是单行 JSON，具有以下字段：

| 字段 | 必需 | 说明 |
|---|---:|---|
| `timestamp` | 是 | ISO-8601 UTC 时间。 |
| `level` | 是 | `debug`、`info`、`warn`、`error`。 |
| `service` | 是 | `web`、`feishu-worker`、`job-worker`、`ocr`。 |
| `event` | 是 | 稳定事件名，如 `job.claimed`、`ocr.extraction.failed`。 |
| `message` | 是 | 安全、面向运维的简短描述。 |
| `requestId` | Web 可选 | HTTP 请求关联 ID；响应头返回 `x-request-id`。 |
| `jobId` | 任务可选 | 异步任务 ID。 |
| `claimId`、`receiptId`、`policySourceId` | 可选 | 内部关联 ID，不作为 Loki label。 |
| `attempt`、`durationMs`、`status`、`failureCode` | 按事件 | 仅结构化安全状态。 |
| `traceId`、`spanId` | 后续 | OpenTelemetry 注入后使用。 |

禁止字段：`objectKey`、`bytes`、`authorization`、`cookie`、`token`、`open_id`、`content`、`extractionPayload`、`prompt`、`embedding`、原始请求/响应体。

日志级别规则：状态转移、入队、成功使用 `info`；可恢复失败使用 `warn`；人工复核、权限拒绝与最终失败使用 `warn` 或 `error`，但不输出原始异常栈中的外部响应正文。

## 5. 仪表盘、查询与告警

### 初始仪表盘

- **任务运行总览：** `AsyncJob` 事件吞吐、按种类的 `PENDING/RUNNING/RETRY_WAIT/REVIEW_REQUIRED` 数量、平均处理时长。
- **OCR 健康度：** 提取成功率、失败码分布、重试次数、人工复核新增量。
- **Worker 健康度：** 最后心跳、轮询耗时、领取失败、未处理任务最早等待时间。
- **飞书与 Web 错误：** 5xx/处理失败数量，按服务与安全错误码过滤。

### 初始告警

- `job-worker` 5 分钟没有心跳；
- 任一 `RECEIPT_EXTRACTION` 任务等待超过 15 分钟；
- 10 分钟内 OCR 失败率超过 20% 且样本不少于 10；
- 30 分钟内 `REVIEW_REQUIRED` 新增超过 20；
- Loki/Alloy 自身采集错误。

告警先发送到管理员配置的飞书群机器人或邮件渠道；告警正文只携带仪表盘链接、服务、阈值与安全失败码。

## 6. 权限、留存与部署

- Grafana 采用本地管理员账号并由反向代理或企业 VPN 限制入口；禁止匿名访问。
- Loki 不单独提供公开路由，也不应由浏览器应用直接请求。
- 日志 volume 使用 Docker 管理，保留期 30 天；业务审计表保留策略独立制定。
- Alloy 读取 Docker socket 属于高权限能力，只在专用观测容器挂载只读 socket；应用容器不得挂载该 socket。
- 环境变量、Grafana 管理员密码和告警 webhook 仅存 `.env.local`/生产 Secret，禁止出现在配置仓库或日志中。

## 7. 验收标准

1. Docker Compose 启动后，Grafana 能查询 `web`、`feishu-worker`、`job-worker`、`ocr` 的容器日志。
2. 所有应用日志符合 JSON 契约；测试证明敏感字段不会被序列化或采集。
3. 给定 `requestId` 或 `jobId`，运维人员能从 Grafana Explore 找到同一链路的安全日志。
4. Grafana/Loki 不暴露到公共主机端口，匿名请求无法访问。
5. 任务积压、OCR 高失败率和 Worker 无心跳可触发测试告警规则。
6. 30 天留存和资源限制在 Compose 配置中明确，删除/过期日志不会影响 PostgreSQL 审计事实。
7. 接入 OpenTelemetry 后不改变既有日志字段与检索方式，trace ID 能关联到日志。
