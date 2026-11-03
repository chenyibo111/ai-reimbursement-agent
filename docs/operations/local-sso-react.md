# React + Go 本地统一登录

本说明适用于 React 工作台与 Go API。Go 负责浏览器认证；旧 Next.js Web 服务默认不启动。飞书机器人和 Node 任务 Worker 继续独立运行，机器人使用同一企业成员键解析员工 ID。React 工作台不提供 Agent 对话入口。

## 启动前

1. 启动 `feishu-sso` 的 `compose.yaml`，按其 README 运行 Go 登录服务，并在 SSO 仓库运行 `scripts/register-clients.ps1`。脚本会登记 `reimbursement-web` OIDC 客户端。
2. SSO 的 `.env` 与报销项目的 `.env.local` 填入相同的随机 `SSO_SERVICE_KEY`（至少 32 字符）。该值仅供 Go API 查询 SSO 的 `sid` 状态，不进入浏览器。SSO Go 服务需由包含新密钥的版本启动。
3. 报销项目的 `.env.local` 按 `.env.example` 配置 `REIMBURSEMENT_SSO_REDIRECT_URI`、`REIMBURSEMENT_SSO_POST_LOGOUT_URI`、`SSO_STATUS_URL`、`SSO_INTERNAL_SESSION_STATUS_URL`、`HYDRA_DIAL_ADDRESS`。`FEISHU_SSO_APP_ID` 必须填写 SSO 应用 ID，`FEISHU_APP_ID` 必须填写机器人应用 ID，`FEISHU_TENANT_KEY` 必须与 SSO 服务的测试企业一致。两个应用都需具备读取成员 `user_id` 的通讯录字段权限（`contact:user.employee_id:readonly`）和相应可见范围。`DATABASE_URL` 指向 `localhost:15433`，`S3_PUBLIC_ENDPOINT` 指向 `localhost:19000`，并配置示例文件中的端口变量。两个项目可同时运行。
4. `REIMBURSEMENT_AUTH_HS256_SECRET`、`REIMBURSEMENT_AUTH_PROVISIONING_KEY`、`SESSION_SECRET` 沿用报销项目既有随机值，不要复制 SSO 服务密钥作为其他密钥。

若 SSO 的 PostgreSQL 已占用宿主机 `5433`，报销项目必须用另一个宿主机端口。保留现有 Compose 项目名和数据卷，在 `.env.local` 增加 `REIMBURSEMENT_POSTGRES_PORT="15433"`，并将既有 `DATABASE_URL` 的 `localhost:5433` 改为 `localhost:15433`（用户名、密码、库名保持原值）。这样不会新建一套空白数据库。

## 启动报销项目

在已有报销项目目录运行前，先用 `docker compose ls` 确认当前 Compose 项目名，并在 `.env.local` 中设置相同的 `COMPOSE_PROJECT_NAME`。本机现有报销项目为 `reimbursement-sso`，所有报销核心服务及 Loki/Alloy/Grafana/Alertmanager 都使用它。现在只需根目录的 `docker-compose.yml` 和 `.env.local`；旧 `.local-sso/compose.override.yaml` 不再参与启动。不同项目名会创建独立容器和数据卷，即使使用同一个代码目录。

```powershell
docker compose --env-file .env.local --profile migration --profile knowledge up -d postgres
npx prisma migrate deploy --config prisma7.config.ts
```

现有数据库先运行尚未部署的 Prisma 迁移；Go SQL 只执行尚未应用的文件，不要把全量脚本对已有业务库重放。下面的 `000016` 至 `000018` 示例只适用于尚未接入统一登录的旧库；本机当前 `reimbursement-sso` 已完成这些迁移，无需再次执行。全新空库应从 `000001` 按文件名顺序执行所有 Go SQL 迁移。

```powershell
# 仅用于尚未应用 000016-000018 的旧库；本机当前库跳过此循环。
$files = @('000016_go_sso_auth.sql', '000017_employee_identity_links.sql', '000018_employee_identity_merges.sql')
foreach ($file in $files) {
  Get-Content -Raw "services/reimbursement-api/db/migrations/$file" |
    docker compose --env-file .env.local exec -T postgres psql -U reimbursement -d reimbursement -v ON_ERROR_STOP=1 -q
  if ($LASTEXITCODE -ne 0) { throw "Go migration failed: $file" }
}
```

全新空库执行 Go SQL 时，将上例中的 `$files` 换成以下按文件名排序的清单，再运行同一个 `foreach` 循环。完成迁移后启动服务：

```powershell
$files = Get-ChildItem services/reimbursement-api/db/migrations/*.sql |
  Sort-Object Name | ForEach-Object Name
```

```powershell
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability build reimbursement-api feishu-bot-worker
docker compose --env-file .env.local --profile migration --profile knowledge --profile observability up -d minio minio-init clamav ocr embedding-service nats reimbursement-api reimbursement-web reimbursement-edge feishu-bot-worker job-worker reimbursement-worker agent-event-worker loki alloy grafana alertmanager alert-relay
```

`prisma migrate deploy` 在宿主机运行时使用 `.env.local` 的 `DATABASE_URL`。首次启动需要等待 OCR 镜像与模型准备。打开 `http://localhost:8088/claims`。报销项目的 Go API 只在 Compose 内网暴露；BFF 和 Go 在每次受保护请求时查询 SSO，查询失败时拒绝访问。

从 Next.js Web 切到 Go 认证后，旧浏览器会话不会迁移；首次打开 React 工作台请重新登录。普通 Compose 启动不会运行 `web`。需要临时启动旧入口时，单独使用 `docker compose --env-file .env.local --profile legacy-web up -d web`；它使用 `.env.local` 中的 `REIMBURSEMENT_NEXT_PORT`（本机为 13000）。回滚网关时需将 `infra/nginx/reimbursement-routes.conf` 的 `$auth_bff_upstream` 指回 `web:3000`，然后重建 `reimbursement-edge`。Node Worker 服务无需切换。

## 验收

1. 用测试企业成员访问 React 工作台，完成飞书登录，确认姓名与报销项目员工记录正确。另一个成员请用独立浏览器会话验证。
2. 在演示项目 A/B 中登录同一成员，确认三个项目共享 SSO 登录。
3. 在 React 工作台点“退出所有项目”；刷新两个演示项目，均应退出。再从演示项目退出，刷新 React 工作台应重新登录。
4. 退出前复制的短期 Web JWT 在 Go API 上也必须立即返回 401。SSO Go 服务停止时，React BFF 和 Go Web API 应拒绝受保护请求。飞书机器人和 Agent 专用令牌不受这次 React 身份接入影响。

后端退出通知用于加快本地会话删除；Go 对 SSO `sid` 的逐次查询负责保证通知延迟时旧 JWT 仍不可用。`reimbursement-web` 的回调、退出后地址和后端退出地址分别为 `http://localhost:8088/api/auth/sso/callback`、`http://localhost:8088/logged-out`、`http://host.docker.internal:8088/api/auth/sso/backchannel-logout`。

如果浏览器仍保留接入前的演示项目 SSO 登录，先在演示项目退出并重新通过飞书登录一次，使 SSO 写入该成员的企业身份映射。新 SSO 应用的飞书 `open_id` 可能与报销项目原飞书应用不同；需要管理员或财务复核员身份时，在本项目 `.env.local` 的角色名单中填写新应用对应的 `open_id`。

## 旧员工身份对账

两个飞书应用必须先取得同一企业成员的 `user_id` 读取权限。Web 首次登录后，`reimbursement.employee_members` 会记录已验证的 `(tenant_key,user_id)` 与系统员工 ID；机器人首次发消息时会解析相同的企业身份键。如果历史机器人员工已有另一条记录，解析会返回 `IDENTITY_CONFLICT`，不会把两个员工的单据自动合并。

先用只读 SQL 查出候选 ID，再为**一个已核实的成员**创建映射文件（以下值仅为格式示例；对账命令会输出引用数量）：

```sql
SELECT tenant_key, user_id, employee_id FROM reimbursement.employee_members
WHERE tenant_key = '<企业 tenant_key>' AND user_id = '<同一成员 user_id>';
SELECT id, feishu_user_id FROM reimbursement.employees
WHERE feishu_user_id = '<机器人应用中的旧 open_id>';
```

```json
{
  "tenantKey": "tenant_example",
  "userId": "user_example",
  "canonicalEmployeeId": "web-employee-id",
  "duplicateEmployeeId": "old-bot-employee-id",
  "duplicateAppId": "cli_bot_app_id",
  "duplicateOpenId": "ou_old_bot_open_id"
}
```

对账命令会用指定飞书应用的凭证实时查询 `duplicateOpenId`，要求其 `user_id` 与已绑定的 Web 员工一致；不能凭姓名或邮箱匹配。仅在管理员确认映射和备份后执行 `--apply`。默认运行只输出各表引用数和将失效的会话数，不修改数据库：

```powershell
$env:RECONCILE_FEISHU_APP_ID = '<机器人应用 ID>'
$env:RECONCILE_FEISHU_APP_SECRET = '<机器人应用密钥>'
$env:FEISHU_TENANT_KEY = '<企业 tenant_key>'
$env:DATABASE_URL = '<数据库连接串>'
cd services/reimbursement-api
go run ./cmd/reconcile-employee-identities --mapping <映射文件绝对路径>
go run ./cmd/reconcile-employee-identities --mapping <映射文件绝对路径> --apply --backup-confirmed
```

执行时会在同一事务里转移两套数据库的业务归属引用、绑定机器人应用身份，并使 Web 会话失效。历史审计引用保留原操作者 ID；旧员工记录保留为无飞书登录绑定的停用归档，并在 `employee_identity_merges` 记录映射。若两人的角色或停用状态不同，或引用表存在唯一键冲突，命令报错并回滚，需人工复核。不要对未经飞书验证的历史账号执行归并。完成后用 Web 和机器人分别查询同一单据，再用另一名员工确认无法访问。
