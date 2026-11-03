# AI 报销 Agent

面向企业员工的报销工作台与飞书机器人。当前主路径由 **React 工作台 + Go 报销 API** 承载；Agent 通过受控的 Go 工具网关读写本人单据。Next.js 页面和部分旧接口仍在仓库中，默认不启动，也不是报销业务的写入入口。

## 当前架构

```text
浏览器 ── 8088 Nginx 边缘入口 ── React 工作台
                          ├── Go 登录与报销 API ── PostgreSQL（报销数据、政策版本）
                          └── 独立 feishu-sso ── Hydra / 飞书企业登录

飞书消息 ── 长连接 Node Worker ── Agent 意图与编排 ── Go 工具网关
                                                   └── 本人单据、票据、校验、提交
票据 ── MinIO ── 安全扫描 / OCR Worker ── 人工复核
飞书文档 ── 政策同步 Worker ── PostgreSQL + pgvector ── 政策问答
服务日志 ── Alloy ── Loki ── Grafana / Alertmanager / 飞书告警
```

报销运行环境使用 **一个** Compose 项目；本机当前名称为 `reimbursement-sso`。独立的 [飞书 SSO 仓库](https://github.com/chenyibo111/yb-sso) 负责企业登录，并保留它自己的 Hydra/PostgreSQL Compose 项目。两个项目数据库不同，SSO 的 PostgreSQL 使用本机 5433，报销的 PostgreSQL 使用本机 15433。

| 目录 | 职责 |
| --- | --- |
| `apps/web/` | React + Vite 员工工作台与管理页面 |
| `services/reimbursement-api/` | Go 登录 BFF、报销 API、规则校验、提交与数据访问 |
| `src/worker/`、`src/application/` | 飞书长连接、Agent 编排、异步任务与政策同步 |
| `src/infrastructure/`、`src/domain/` | Go 工具边界的 Node 侧适配、模型、知识库与领域约束 |
| `ocr-service/`、`embedding-service/` | PaddleOCR 与 BGE-M3 嵌入服务 |
| `prisma/`、`services/reimbursement-api/db/migrations/` | Agent/旧模块与 Go 报销模块各自的 SQL 迁移 |
| `observability/` | Loki、Alloy、Grafana、Alertmanager 配置 |
| `app/`、`src/ui/` | 保留的旧 Next.js 页面；仅 `legacy-web` profile 启动 |

## 主要功能和边界

- **Web**：SSO 登录后创建、保存或提交报销单；填写报销事由、申请总额、CNY 币种、备注，上传或删除草稿票据，查看识别结果、政策提醒与提交快照。列表支持筛选、分页和单据详情。
- **Agent**：飞书单聊办理本人单据、按条件查询、选定本人草稿、上传票据、查金额与进度、咨询政策，并经服务端复核后确认提交。群聊只响应 @机器人，且不披露个人单据。React 工作台不提供 Agent 对话入口。
- **票据与复核**：JPG/PNG/PDF 安全检查、MinIO 私有存储、异步 OCR；低置信度、异常或重复票据进入 Go 财务复核队列。
- **政策**：管理员发布版本化 Go 校验规则；提交时以生效版本重新校验，阻断或提示。授权的飞书 Docx/Wiki 可同步到 pgvector，用于带证据的政策问答。文档问答不等于本单已通过提交校验。
- **尚未接入**：真实审批和付款系统。旧 Next.js 业务数据和页面不作为当前生产主路径。

## 本机启动

先按 [飞书 SSO README](https://github.com/chenyibo111/yb-sso#启动) 启动它的 Compose 依赖、登记 `reimbursement-web` OIDC 客户端并运行 SSO Go 服务（本机 9000）。SSO 与报销项目的服务密钥、企业标识和飞书应用权限必须按 [统一登录运维说明](docs/operations/local-sso-react.md) 配置。

在本仓库：

```powershell
Copy-Item .env.example .env.local
# 编辑 .env.local，填入本机凭据与服务地址
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability up -d --build
docker compose --env-file .env.local ps
```

已有本机环境直接复用现有 `.env.local`，**不要重新复制示例文件**。尤其保留 `COMPOSE_PROJECT_NAME`，否则 Compose 会创建另一套空白数据库和 MinIO 卷。本机现有项目名为 `reimbursement-sso`。默认 Web 入口是 [http://localhost:8088/claims](http://localhost:8088/claims)；旧 Next.js 入口 3000/13000 不在主路径上。

首次新建数据库时，先启动 `postgres`，运行 `npx prisma migrate deploy --config prisma7.config.ts`，再按 [本地统一登录说明](docs/operations/local-sso-react.md) 顺序应用 Go SQL 迁移，然后启动其余服务。已有数据库只需应用尚未部署的迁移。不要删除命名卷来“重置”环境。

```powershell
# 查看所有报销服务（含日志平台）
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability ps

# 停止并移除容器与网络；保留数据库、附件、模型及日志卷
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability down
```

日志平台现已归入同一个 `reimbursement-sso` Compose 项目。旧 `ai-reimbursement-agent_loki-data` 与 `ai-reimbursement-agent_grafana-data` 卷暂时保留作为回退副本；当前服务使用 `reimbursement-sso_loki-data` 和 `reimbursement-sso_grafana-data`。不要用 `down -v`。迁移和回退步骤见 [Compose 收敛记录](docs/operations/compose-consolidation.md)。

## 开发与 CI

```powershell
# Agent / Node：测试使用专用 TEST_DATABASE_URL
npm ci
npx prisma generate --config prisma7.config.ts
npm run db:test:migrate
npm run lint
npx tsc --noEmit
npm test
npm run build

# React 工作台
npm ci --prefix apps/web
npm test --prefix apps/web
npm run build --prefix apps/web

# Go 报销 API
cd services/reimbursement-api
go test ./...
go vet ./...
go build ./cmd/...
```

两个仓库的 GitHub Actions 在 push 和 pull request 时执行数据库集成测试、静态检查和构建。CI 使用独立的临时 PostgreSQL；真实飞书登录、机器人事件、模型服务和端到端浏览器流程仍需按运维文档现场验收。

## 文档

- [统一登录与本地验收](docs/operations/local-sso-react.md)
- [Agent 本人单据办理验收](docs/operations/agent-owned-claim-acceptance.md)
- [飞书集成](docs/feishu-integration.md)
- [架构与信任边界](docs/architecture.md)
- [运维与日志](docs/operations.md)
- [React + Go 迁移历史与回退](docs/migration/react-go-cutover-runbook.md)

本仓库采用 [MIT License](LICENSE)。
