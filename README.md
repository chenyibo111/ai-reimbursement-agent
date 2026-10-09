# AI Reimbursement Agent

## React + Go migration

The current Next.js application remains the active product while the new architecture is built behind a migration profile. `services/reimbursement-api` will become the sole writer for reimbursement data, `apps/web` will become the React client, and `services/agent` will call the Go API through a typed tool boundary. Do not route employee traffic to the migration profile until its cutover runbook and reconciliation checks are complete.

### 迁移中的统一飞书身份

迁移 Profile 下，Next.js 只承担 Auth BFF：它完成飞书 OAuth、保存 HttpOnly 会话，并在 `GET /api/auth/access-token` 为 React 签发 15 分钟、仅保存在内存的 Web JWT。React 通过统一边缘路由调用 Go API；飞书机器人首次收到消息时也会按同一 `open_id` 创建或复用员工并同步 Go 员工投影。Web 与 Agent Token 分别绑定 `channel=web` 和 `channel=agent`，不能互用。

个人本地验证时，在飞书开放平台登记与浏览器访问地址完全一致的回调地址，并配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REDIRECT_URI`、`APP_PUBLIC_URL`、`REIMBURSEMENT_AUTH_HS256_SECRET`、`REIMBURSEMENT_AUTH_PROVISIONING_KEY` 和角色白名单。开发登录还必须配置非敏感的 `DEV_DEMO_FEISHU_OPEN_ID`。多人 Staging 前必须换成固定 HTTPS 域名；临时 `trycloudflare` 地址不能作为多人 OAuth 与工作台深链入口。完整变量边界与验收步骤见[统一身份运维说明](docs/operations/unified-feishu-identity.md)。

面向中国单企业员工的 AI 报销服务。它把“上传票据、识别票据、补齐报销信息、校验制度、生成并提交报销单”组织成一条可审计、可人工确认的链路。

项目当前提供独立 Web 工作台，并可选接入飞书 OAuth、飞书机器人和以飞书文档为来源的报销政策知识库。

> **当前边界**：Agent 会话独立于报销单。Web 悬浮入口与飞书单聊共享同一员工私有历史；飞书群聊按成员隔离。政策问答不会建单，只有明确“开始报销”或上传合规票据才进入受控办理，且仅精确输入“确认提交”会触发服务端复核并提交。

## 功能一览

| 模块 | 当前能力 |
| --- | --- |
| 报销单 | 创建草稿、编辑用途和费用字段、填写申请报销总额（仅 CNY）与备注、生成确认摘要、提交并查看提交快照 |
| 票据 | 上传 JPG、PNG、PDF；文件签名校验、ClamAV 扫描、私有对象存储、异步 OCR 识别、重新识别和删除草稿票据 |
| 校验 | 必填字段、低置信度、同文件哈希、同员工已提交发票号，以及已发布的制度规则校验 |
| AI 助手 | 独立私有会话、跨 Web/飞书单聊历史、政策依据回放、受控 Intake 办理与精确确认提交 |
| 政策中心 | 管理员维护版本化的结构化规则，支持阻断与预警级别，并将提交时命中的规则写入不可变快照 |
| 政策知识库 | 从获授权的飞书 Docx/Wiki 手动同步、切片、向量检索；回答只能引用命中的原文片段 |
| 身份与飞书 | 飞书 OAuth 登录、仅开发环境的受限演示登录、长连接飞书机器人 Worker |
| 审计与恢复 | 草稿写入、建议处理、提交和政策发布均有审计/快照；失败链路保留安全的错误分类 |
| 任务与复核 | PostgreSQL 持久化任务、lease 领取与退避重试；低置信度/重复票据进入财务复核，政策同步失败进入管理员复核 |

## 用户路径

### Web 报销工作台

1. 使用飞书 OAuth 登录（开发环境可使用受限演示登录）。
2. 在 `/claims` 查看自己创建的报销单，或在 `/claims/new` 新建草稿。
3. 上传票据；系统完成安全扫描与私有存储后创建 OCR 任务，后台 Worker 再回填候选费用信息。
4. 在单据详情核对票据、费用、用途和校验结果。申请报销总额会先采用已识别票据金额的合计作为建议值；员工手工修改后以手工值为准，也可恢复当前 OCR 建议值。币种当前固定为 CNY，备注最长 1000 个字符。
5. 修复阻断项，生成确认摘要后提交。系统以当前版本再次校验并写入不可变 `SubmissionSnapshot`。

草稿状态会经历 `DRAFT`、`PROCESSING`、`NEEDS_INFORMATION`、`AWAITING_CONFIRMATION`、`SUBMITTED`。仅草稿允许删除单据或附件。

### 飞书机器人

机器人采用独立的长连接 Worker：单聊会进入员工私有会话，群聊只响应 `@机器人` 且按成员隔离。它会复用 Web 的事件幂等、票据安全处理、OCR、政策检索、Intake 和提交复核服务；政策问答不建单，上传票据或“开始报销”才创建办理状态。删除仍仅限草稿工作台；确认提交仅接受精确文本 `确认提交`。

完整开放平台权限、长连接配置和测试清单见[飞书集成说明](docs/feishu-integration.md)。

### 报销政策与知识库

- 员工可以在 `/policies` 阅读已发布的结构化政策摘要。
- 政策管理员在 `/admin/policies` 维护草稿、规则和发布日期；管理员身份由飞书 `open_id` 白名单决定。
- 管理员在 `/admin/policy-sources` 登记获授权的飞书 Docx 或 Wiki 链接并手动同步。
- 同步生成不可变文档快照和 `pgvector` 向量切片。内容未变时不重复嵌入，失败不会覆盖上一份活动快照。
- AI 只能基于检索出的来源片段回答制度问题；未检索到证据时必须说明无法确认，而不是猜测规则。

### 人工复核中心

- 财务复核员和管理员可在 `/admin/reviews` 查看票据识别任务；普通员工不能访问该入口。
- 复核员领取 OCR 任务后可确认、更正票据字段、创建面向员工的补充项或关闭任务；字段更正受报销单版本保护并写入审计记录。
- 只有管理员能为政策来源同步任务重新排队。员工界面只展示安全状态（如“正在人工核验”），不会显示内部失败码。

## 核心架构

```text
浏览器 / 飞书用户
       │
       ├── Next.js Web 与 Route Handlers ── 签名会话 / 授权 / UI
       │        │
       │        └── Application use cases ── 草稿、票据、校验、建议、提交
       │                    │
       ├── 飞书长连接 Worker ───────────────┘
       └── 异步任务 Worker ── OCR / 政策同步 / 人工复核分流
                    │
    ┌───────────────┼──────────────────────────────┐
    │               │                              │
PostgreSQL + pgvector  MinIO (私有票据)   ClamAV / PaddleOCR / Embedding Service
 Prisma 7              S3 API             Docker 服务
```

| 层次 | 主要目录 | 职责 |
| --- | --- | --- |
| 页面与 API | `app/` | Next.js 页面、认证布局、Route Handlers |
| 交互组件 | `src/ui/` | 票据上传、费用表、校验面板、政策与 Agent UI |
| 应用用例 | `src/application/` | 创建草稿、上传/识别票据、校验、建议、提交、飞书事件、政策同步 |
| 领域模型 | `src/domain/` | 报销单、票据、校验、Agent、政策规则与来源约束 |
| 基础设施 | `src/infrastructure/` | Prisma、MinIO/S3、OCR、Embedding、飞书 SDK、模型 Provider |
| 后台进程 | `src/worker/` | 飞书机器人长连接、持久化任务 Worker、角色初始化 |
| 数据库 | `prisma/` | Prisma schema 和已提交的 PostgreSQL 迁移 |
| 外部服务 | `ocr-service/`、`embedding-service/` | PaddleOCR HTTP 服务与 BGE-M3 Embedding 服务 |
| 测试 | `tests/unit/`、`tests/integration/`、`tests/e2e/` | 领域/应用单测、PostgreSQL 集成测试、Playwright 流程测试 |

更细的安全边界与数据流见[架构说明](docs/architecture.md)。

## 技术栈

- **Web**：Next.js 15、React 19、TypeScript。
- **数据**：PostgreSQL 16、Prisma 7、`pgvector`（政策切片向量）。
- **对象存储**：MinIO，生产可替换为兼容 S3 的私有存储。
- **安全**：文件类型与签名校验、ClamAV 病毒扫描、HttpOnly 签名会话、服务端授权。
- **OCR**：PaddleOCR，运行于独立 HTTP 服务；也可切换测试用 Fixture Provider。
- **模型**：默认 Fixture；可配置任意 OpenAI-compatible Chat Completions 服务。
- **飞书**：`@larksuiteoapi/node-sdk`，OAuth 与长连接机器人。
- **质量保障**：Vitest、Playwright、ESLint、TypeScript。
- **交付**：Docker Compose；Web 与飞书 Worker 使用同一镜像、不同命令运行。

## 快速开始（本地开发）

### 前置条件

- Node.js 与 npm（仓库声明 `npm@11.9.0`）
- Docker Desktop（PostgreSQL、MinIO、ClamAV、OCR 及可选 Embedding 服务）
- 若启用真实飞书登录或机器人：飞书自建应用凭据

### 1. 准备环境变量

```powershell
Copy-Item .env.example .env.local
```

编辑未提交的 `.env.local`，至少填写数据库、MinIO、会话密钥和服务地址。不要提交 `.env.local`、飞书 App Secret、模型 API Key 或 MinIO 密钥。

### 2. 启动基础依赖

```powershell
docker compose up -d postgres minio clamav ocr
npm install
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
npm run dev
```

默认访问地址与端口：

| 服务 | 地址 |
| --- | --- |
| Web | `http://localhost:3000` |
| PostgreSQL | `localhost:5433` |
| MinIO S3 API | `http://localhost:9000` |
| MinIO Console | `http://localhost:9001` |
| OCR HTTP 服务 | `http://127.0.0.1:8000` |
| ClamAV | `localhost:3310` |

Windows 上若 Prisma 原生迁移引擎受限，可在 Linux 容器中执行迁移；所有数据库变更必须来自仓库中已提交的 `prisma/migrations/`。

### 3. 登录与本地演示

正式登录使用飞书 OAuth：

```dotenv
SESSION_SECRET="replace-with-a-long-random-secret"
FEISHU_APP_ID="cli_..."
FEISHU_APP_SECRET="..."
FEISHU_REDIRECT_URI="http://localhost:3000/api/auth/feishu/callback"
```

访问 `/api/auth/feishu/login` 开始授权。没有飞书应用时，仅本地环境可使用 `POST /api/auth/dev-login`；它只读取服务端配置的 `DEV_DEMO_EMPLOYEE_ID`、`DEV_DEMO_EMPLOYEE_NAME` 与必填的 `DEV_DEMO_FEISHU_OPEN_ID`，生产环境不提供该入口。

## 可选能力配置

### 真实对话模型

默认 `MODEL_PROVIDER="fixture"`，适用于开发与自动测试。接入兼容 Chat Completions 的服务时：

```dotenv
MODEL_PROVIDER="openai-compatible"
MODEL_BASE_URL="https://<provider>/v1"
MODEL_NAME="<model-name>"
MODEL_PROVIDER_API_KEY="<secret>"
MODEL_TIMEOUT_MS="20000"
```

服务端只构造脱敏草稿摘要、受控校验信息和政策证据；密钥不发送给浏览器，也不写入日志。模型不可用时，员工仍可在工作台手动补齐字段。

### 本地 OCR

```dotenv
RECEIPT_EXTRACTION_PROVIDER="paddleocr"
OCR_SERVICE_URL="http://127.0.0.1:8000"
```

OCR Provider 负责提取发票号、开票日期、金额、税额和销售方等结构化字段。识别失败不会删除原票据；员工可以在工作台重新识别或手工填写。

### 政策知识库与 Embedding

开发机以宿主机运行 Web 时启动 CPU Embedding 服务：

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile knowledge up -d embedding-service
```

并在 `.env.local` 设置：

```dotenv
EMBEDDING_PROVIDER="bge-m3"
EMBEDDING_BASE_URL="http://127.0.0.1:8081"
EMBEDDING_MODEL="BAAI/bge-m3"
EMBEDDING_DIMENSIONS="1024"
```

首次同步会下载模型，缓存位于 Docker 命名卷 `embedding-models`。生产使用 Docker 内网的 `http://embedding-service:8080`，不要把该端口发布到公网。具有 NVIDIA GPU 的生产环境可叠加 `docker-compose.gpu.yml`。

### 飞书机器人 Worker

在飞书开放平台启用机器人能力、配置**长连接**并订阅 `im.message.receive_v1` 后，填入：

```dotenv
FEISHU_BOT_ENABLED="true"
FEISHU_BOT_OPEN_ID="ou_..."
FEISHU_EVENT_DELIVERY="long_connection"
APP_PUBLIC_URL="https://reimbursement.example.com"
```

开发环境需分别运行 Web 与 Worker：

```powershell
npm run dev
npm run feishu:worker
```

机器人权限、群聊 `@机器人` 限制、故障恢复和验收清单见[飞书集成说明](docs/feishu-integration.md)。

飞书上传票据会收到两条消息：第一条确认已接收并开始识别；`job-worker` 结束 OCR 后，`feishu-bot-worker` 会向原会话发送第二条识别摘要。摘要会列出发票号码、开票日期和价税合计；任一字段缺失或置信度低于 0.9 时，会明确要求员工确认，并在需要时提示“已转人工复核”。Web 上传不发送飞书通知。

### 异步任务 Worker 与角色初始化

Web 只负责创建任务；必须同时运行任务 Worker，才会处理 OCR 和政策来源同步：

```powershell
npm run dev
npm run job:worker
```

首次部署后，为已确认的员工记录授予一个管理员角色（只执行一次，并妥善核对员工 ID）：

```powershell
npm run roles:bootstrap -- <employeeId>
```

角色保存在数据库中：`EMPLOYEE` 只能访问自己的报销单，`FINANCE_REVIEWER` 可处理 OCR 复核，`ADMIN` 可管理政策同步、角色和所有复核任务。旧的 `POLICY_ADMIN_FEISHU_OPEN_IDS` 白名单只作为迁移期兼容路径；完成角色初始化后应移除它。

## 生产部署

Web、飞书 Worker 与异步任务 Worker 使用同一个 Docker 镜像，分别运行 `npm run start`、`npm run feishu:worker` 与 `npm run job:worker`：

```powershell
docker compose up -d --build web feishu-bot-worker job-worker
```

React + Go 迁移演练使用统一边缘入口，而不是直接暴露 Go API：

```powershell
docker compose --profile migration up -d --build reimbursement-edge reimbursement-web reimbursement-api
```

本机可通过 `http://localhost:8088` 验证路径分流；旧 Auth BFF 的 `3000` 仅绑定 `127.0.0.1` 供本机调试。生产环境应只将固定 HTTPS 域名指向 `reimbursement-edge`。

### 报销单号、票据识别与申请信息升级

`services/reimbursement-api/db/migrations/000010_claim_numbers_and_receipt_metadata.sql` 为 Go 报销库增加不可变业务单号（`BXyyyyMMdd-序号`）与票据开票日期、价税合计、销售方字段。它还会为已有报销单回填单号；未能从历史 OCR 结果取得的新字段保持为空，由 React 工作台显示为“待补充”。随后执行的 `000011_claim_application_fields.sql` 增加申请报销总额、固定 CNY 币种、金额来源和备注字段。

迁移顺序不可调换：先备份目标 PostgreSQL，再以具备 DDL 权限的受控运维账户执行脚本，最后同步滚动重启 Go API、Go Worker、React Web 与边缘路由。本地 Compose 示例：

```powershell
Get-Content -Raw services/reimbursement-api/db/migrations/000010_claim_numbers_and_receipt_metadata.sql |
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement

docker compose --profile migration up -d --build reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
```

重启后，在 React 报销列表和工作台分别核对：新建草稿立即获得 `BXyyyyMMdd-xxxx`；已识别票据显示发票号、日期、价税合计、销售方和置信度；缺失字段显示“待补充”而非 `￥0.00`；申请报销总额仅在仍使用 OCR 建议时自动刷新，手工金额不会被 OCR 覆盖；提交前检查仍按既有规则运行。完整的生产验收与回退边界见[运维说明](docs/operations.md#报销单号与票据识别字段升级)。

部署前应按以下顺序执行：

1. 备份 PostgreSQL；不要用删除卷或重建数据库代替迁移。
2. 将生产环境变量作为 Docker secret/部署平台密钥注入，不写入镜像或 Git。
3. 执行 `npx prisma migrate deploy --config prisma7.config.ts`。
4. 确保 Web 的 `APP_PUBLIC_URL` 是员工可访问的 HTTPS 地址。
5. 确认容器内服务主机名使用 `postgres`、`minio`、`clamav`、`ocr` 和 `embedding-service`。
6. 启动 Web、两个 Worker 和依赖服务，检查健康状态与 Worker 日志。

更完整的迁移、监控、回滚与安全日志规范见[运维说明](docs/operations.md)。

## 安全与数据边界

- 票据只存储在私有 S3/MinIO 对象中，不提供匿名下载路径。
- 上传限制为 JPEG、PNG、PDF；最大 20MB，PDF 最多 20 页，并在存储前校验文件签名和扫描病毒。
- 不信任浏览器传入的员工身份、管理员角色、草稿版本或字段目标；所有授权和版本校验在服务端完成。
- Agent 只能在独立 Intake 中收集白名单字段；手动草稿不会被自动选中或修改。创建草稿、上传、识别和提交均经服务端用例与归属校验，提交只接受当前 `READY_TO_SUBMIT` Intake 的精确“确认提交”。
- 重复文件哈希与同员工已提交的同发票号会形成阻断校验，避免重复报销与重复计入费用。
- 管理员、财务复核员角色由数据库中的 `Employee.role` 控制；迁移期可保留 `POLICY_ADMIN_FEISHU_OPEN_IDS` 作为旧政策管理入口的兼容白名单。
- 政策知识库仅同步管理员显式登记且应用有权限读取的文档；同步、向量和日志均不暴露来源 token、原始附件或密钥。

## 开发、测试与常用命令

```powershell
# 单元与集成测试（需先启动 PostgreSQL）
npm test

# 类型检查与静态检查
npx tsc --noEmit
npm run lint

# 浏览器端到端测试
npm run test:e2e

# 生产构建
npm run build

# 查看 Compose 解析结果
docker compose config

# 飞书机器人、异步任务 Worker 与角色初始化
npm run feishu:worker
npm run job:worker
npm run roles:bootstrap -- <employeeId>
```

集成测试连接 Docker PostgreSQL：`postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement`。端到端测试会写入测试数据，应使用专用测试数据库或可清理的本地环境，不要指向生产实例。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [架构说明](docs/architecture.md) | 信任边界、领域数据、Agent、政策与知识库安全模型 |
| [运维说明](docs/operations.md) | 数据库迁移、模型/知识库/机器人运行、监控与恢复 |
| [飞书集成说明](docs/feishu-integration.md) | 开放平台权限、长连接 Worker、测试企业验收 |
| [设计规范](DESIGN.md) | UI 视觉与交互基线 |
| [UX 合约](UX-CONTRACT.md) | UI 状态、错误处理和无障碍要求 |
| `docs/superpowers/specs/` | 已确认的功能设计决策 |
| `docs/superpowers/plans/` | 按任务拆分的实施计划与验证命令 |

## 路线图

“跨渠道报销 Agent 会话”已完成：Web 私有会话与飞书单聊共享同一员工私有历史，飞书群聊保持隔离；政策问答不会创建报销单，只有明确开始报销或上传合规票据才进入受控的 Intake 办理状态，并且只有精确输入“确认提交”才会触发服务端重新校验和提交。

设计与实施计划：

- [跨渠道 Agent 会话设计](docs/superpowers/specs/2026-09-27-cross-channel-agent-conversation-design.md)
- [跨渠道 Agent 会话实施计划](docs/superpowers/plans/2026-09-27-cross-channel-agent-conversations.md)

### 待办：固定域名后的飞书深链登录

**前置条件：** 部署稳定的 HTTPS 域名（例如固定域名的 Cloudflare Tunnel）。`trycloudflare.com` 快速隧道会在进程停止后失效且每次生成新域名，不适合作为 OAuth 回调或员工工作台链接。

- 为所有工作台路由增加服务端认证守卫；没有有效会话时自动进入飞书 OAuth，而不是显示 `unauthenticated` 错误。
- 仅允许站内相对路径作为登录后的 `returnTo`，OAuth 回调后返回原始报销单、复核单或管理页面，防止开放重定向。
- 将 `APP_PUBLIC_URL` 和 `FEISHU_REDIRECT_URI` 切换为固定 HTTPS 域名，并在飞书开放平台登记完全相同的回调地址。
- 验收：从飞书消息打开具体 `/claims/<id>`，未登录用户完成授权后回到同一报销单；已登录用户直接进入；外部 `returnTo` 被忽略并回退到 `/claims`。

### 待办：Go 人工复核案件队列切流

当前 Go OCR 迁移链路能将异常票据标记为 `REVIEW_REQUIRED` 并保留安全原因代码，但尚未为每个异常自动创建可领取的 `ReviewCase`；`/admin/reviews` 也尚未提供待办列表。因此在完成前，不能把“需要人工复核”视为已有可操作队列。

- 在重复发票、低置信识别、OCR 重试耗尽等分流时，以事务方式创建或更新关联 `ReviewCase`，保证幂等。
- 提供只对 `FINANCE_REVIEWER` / `ADMIN` 开放的列表、领取、详情和结案 API，并让 React 复核页展示待办队列。
- 对业务阻断（如已提交发票号重复）停止无意义的 OCR 重试；复核原因仅保留一次并可关联已提交单据。
- 验收：异常票据仅生成一条可领取案件，复核操作写入审计，普通员工不能读取内部复核原因。

## 许可证

本仓库采用 [MIT License](LICENSE)。
# AI Reimbursement Agent

## React + Go 迁移

迁移采用按员工和渠道灰度的单写入方策略。执行生产演练前，请阅读 [切流 Runbook](docs/migration/react-go-cutover-runbook.md) 与 [旧写路径退役清单](docs/migration/legacy-retirement-checklist.md)。不要通过删除数据、反向同步或停止 OCR 进行回滚。
