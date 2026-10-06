# 飞书告警通知设计

**日期：** 2026-10-06
**状态：** 已实施，待合并

## 目标与范围

在现有 Loki Ruler 告警规则之上建立实际通知闭环：规则触发、聚合与抑制由 Alertmanager 负责，安全的内部转发服务将告警转换为飞书群机器人卡片并投递到专用告警群。

本次只新增告警投递能力，不改变报销、OCR、知识库或飞书员工机器人业务流程。系统仍不将 Grafana、Loki、Alertmanager 或转发器端口暴露到主机网络。

## 架构

```text
Loki Ruler --内部 HTTP--> Alertmanager --内部 HTTP--> alert-relay --HTTPS--> 飞书群机器人 Webhook
```

### Loki Ruler

保留现有告警规则与阈值，新增 Alertmanager 地址配置，指向 Docker 网络内的 `http://alertmanager:9093`。Ruler 不持有飞书 Webhook，也不负责消息格式转换。

### Alertmanager

新增 `alertmanager` Compose 服务，加入 `observability` profile，只通过 Docker 网络提供 `9093`。配置采用单一飞书接收器，向 `alert-relay` 发送 webhook 事件。

路由策略如下：

- 按 `alertname`、`service`、`severity` 分组；
- `group_wait` 为 30 秒，`group_interval` 为 5 分钟；
- `repeat_interval` 为 4 小时；
- 同一告警存在 `critical` 时抑制同名、同服务的 `warning`；
- 向转发器发送 resolved 事件，因此恢复也会在群内可见；
- Alertmanager 的失败重试与去重是投递可靠性的唯一来源，转发器不自行持久化或二次排队。

### alert-relay

新增最小化 Node/TypeScript HTTP 服务，只接受 Docker 内网的 Alertmanager `POST`。服务不发布主机端口，端点固定为 `/alertmanager`。

它负责：

1. 校验请求为合法的 Alertmanager webhook 负载；
2. 只提取允许字段：告警名、状态、严重级别、服务、摘要、起止时间；
3. 将同一批告警渲染为飞书交互式卡片；
4. 调用 `FEISHU_ALERT_WEBHOOK_URL` 投递；
5. 对请求格式错误返回 400；对飞书返回的非成功响应返回 502，使 Alertmanager 依其规则重试；
6. 输出结构化、安全日志（结果、数量、级别、HTTP 状态、耗时），不记录 Webhook URL、卡片原文、标签全集或告警正文。

当前不生成外部 Grafana/Loki 链接，因为尚无固定且受控的运维域名。后续建立企业域名、反向代理与 Grafana SSO 后，可通过一个独立改动加入链接。

## 安全与数据边界

- `FEISHU_ALERT_WEBHOOK_URL` 仅由 `.env.local` 或生产 Secret 注入，`.env.example` 只保留空变量名；禁止写入 Compose、配置文件、日志、测试快照或 Git 历史。
- `alert-relay`、Alertmanager、Loki、Grafana 均不映射主机端口；生产应处于受控 Docker 网络。
- 飞书卡片不允许包含票据、会话、原始日志、对象键、员工身份信息、请求 ID、任务 ID、数据库错误堆栈或凭据。
- 未设置 `FEISHU_ALERT_WEBHOOK_URL` 时，`alert-relay` 应拒绝启动，避免出现“告警已启用但无接收方”的假象。
- 告警转发失败本身必须被记录；由现有 `ObservabilityPipelineFailed` 与容器日志协助排障。

## 用户可见行为

在专用飞书群中，每条卡片包含：

- 标题：`AI 报销系统告警` 或 `AI 报销系统告警已恢复`；
- 告警级别（`critical` / `warning`）、服务、规则名和摘要；
- 本批次的告警数量；
- 触发或恢复时间。

群消息用于运维通知，不允许回复后驱动业务操作。员工报销机器人、私聊和群聊 `@机器人` 行为不受影响。

## 配置、部署与回滚

增加以下文件：Alertmanager 配置、告警转发器源码与 Dockerfile、转发器测试，以及相关 Compose/运行说明。`docker compose --profile observability up -d --build` 应同时启动 Loki、Alloy、Grafana、Alertmanager 和 alert-relay。

部署前管理员需在未提交环境文件设置：

```dotenv
FEISHU_ALERT_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/..."
```

缺少该变量时，观察性 profile 启动应明确失败；普通 `web`、`job-worker`、`feishu-bot-worker` 不受影响。回滚时停止并移除 Alertmanager/relay 服务即可；Loki 规则仍可计算，但不会进行外部投递。不得删除 Loki 数据卷或修改业务数据库。

## 测试与验收

自动化测试覆盖：

- Alertmanager 与 Loki 配置契约，包括内部服务地址、分组、重复间隔、恢复通知与抑制规则；
- 转发器对 firing、resolved、多个告警的卡片映射；
- 未知字段或敏感标签不会进入卡片；
- 缺少 Webhook 时启动失败；
- 飞书成功、失败和超时分别映射为安全日志与正确 HTTP 状态；
- Compose 仅在 `observability` profile 创建服务，且没有对外端口。

人工验收：在测试环境使用测试飞书群 Webhook，临时触发一条无害测试告警，确认 30 秒聚合后群里收到卡片；恢复后收到恢复卡片；飞书返回失败时，确认 Alertmanager 重试且不泄露 Webhook 或敏感业务数据。

## 非目标

- 不配置实际生产 Webhook、不创建飞书群或修改飞书开放平台权限；
- 不开放 Grafana/Loki/Alertmanager 到互联网；
- 不做告警确认、排班、值班升级、短信或邮件通知；
- 不修改既有告警阈值与业务流程。
