# 报销 Compose 项目收敛

## 当前状态

报销核心服务和日志平台共用根目录 `docker-compose.yml`，项目名由未提交的 `.env.local` 中 `COMPOSE_PROJECT_NAME=reimbursement-sso` 固定。`feishu-sso` 仍是独立项目：它的 Hydra、SSO 数据库和本机 9000 端口不属于报销 Compose。不要在同一代码目录再用 `-p ai-reimbursement-agent` 启动第二套报销服务。

旧项目 `ai-reimbursement-agent` 曾只运行 Loki、Alloy、Grafana、Alertmanager 和告警转发。2026-11-03 已停止旧容器，将两个持久化卷逐文件复制到新项目，并在新项目启动日志服务。复制后的文件数和哈希与原卷一致：Loki 1488 个文件，Grafana 1 个文件。旧卷 `ai-reimbursement-agent_loki-data`、`ai-reimbursement-agent_grafana-data` **仍保留**，不能在确认不再需要回退前删除。

| 用途 | 当前卷 | 暂存的旧卷 |
| --- | --- | --- |
| Loki 日志 | `reimbursement-sso_loki-data` | `ai-reimbursement-agent_loki-data` |
| Grafana 设置 | `reimbursement-sso_grafana-data` | `ai-reimbursement-agent_grafana-data` |

## 日常操作

```powershell
cd D:\AI\ai-reimbursement-agent
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability up -d --build
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability ps
docker compose ls
```

`docker compose ls` 中应只有一个报销项目 `reimbursement-sso`；另一个项目 `feishu-sso` 属于统一登录系统。查看 Loki 就绪与告警规则：

```powershell
docker compose --env-file .env.local --profile observability exec -T loki wget -qO- http://localhost:3100/ready
docker compose --env-file .env.local --profile observability exec -T loki wget -qO- http://localhost:3100/prometheus/api/v1/rules
```

停止服务时使用 `down`，**不要添加 `-v`**，否则会删除当前项目的数据库、附件和日志卷。

```powershell
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability down
```

## 日志平台回退

若新日志栈异常，先停止新项目的五个日志服务，再用旧项目名和保留的旧卷启动这五个服务。此操作不会切换报销业务数据库。

```powershell
docker compose --env-file .env.local --profile observability stop loki alloy grafana alertmanager alert-relay
docker compose --env-file .env.local -p ai-reimbursement-agent --profile observability up -d loki alloy grafana alertmanager alert-relay
```

回退后需要再次切回新项目时，应先停旧日志栈，再复制最新卷数据，避免两个 Loki 同时写同一份日志。卷操作前分别核对源和目标名称；不得使用 `docker compose down -v` 或 `docker volume prune`。
