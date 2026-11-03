# React + Go 本地统一登录

本说明适用于 React 工作台与 Go API。Go 负责浏览器认证；旧 Next.js Web 服务默认不启动。飞书机器人和 Node 任务 Worker 继续独立运行，身份链路不变。

## 启动前

1. 启动 `feishu-sso` 的 `compose.yaml`，按其 README 运行 Go 登录服务，并在 SSO 仓库运行 `scripts/register-clients.ps1`。脚本会登记 `reimbursement-web` OIDC 客户端。
2. SSO 的 `.env` 与报销项目的 `.env.local` 填入相同的随机 `SSO_SERVICE_KEY`（至少 32 字符）。该值仅供 Go API 查询 SSO 的 `sid` 状态，不进入浏览器。SSO Go 服务需由包含新密钥的版本启动。
3. 报销项目的 `.env.local` 按 `.env.example` 配置 `REIMBURSEMENT_SSO_REDIRECT_URI`、`REIMBURSEMENT_SSO_POST_LOGOUT_URI`、`SSO_STATUS_URL`、`SSO_INTERNAL_SESSION_STATUS_URL`、`HYDRA_DIAL_ADDRESS`。`DATABASE_URL` 指向 `localhost:15433`，`S3_PUBLIC_ENDPOINT` 指向 `localhost:19000`，并配置示例文件中的端口变量。两个项目可同时运行。
4. `REIMBURSEMENT_AUTH_HS256_SECRET`、`REIMBURSEMENT_AUTH_PROVISIONING_KEY`、`SESSION_SECRET` 沿用报销项目既有随机值，不要复制 SSO 服务密钥作为其他密钥。

## 启动报销项目

在报销项目目录运行：

```powershell
docker compose --env-file .env.local -p reimbursement-sso --profile migration up -d --build postgres minio minio-init clamav ocr reimbursement-api reimbursement-web reimbursement-edge feishu-bot-worker job-worker
npx prisma migrate deploy --config prisma7.config.ts
```

先运行 Prisma 迁移，再按文件名顺序对 `reimbursement` 数据库执行 Go SQL 迁移。已有数据库也必须执行新增的 `000016_go_sso_auth.sql`；迁移使用 `IF NOT EXISTS`，重复执行不会删除员工或单据：

```powershell
Get-ChildItem services/reimbursement-api/db/migrations/*.sql | Sort-Object Name | ForEach-Object { Get-Content -Raw $_.FullName | docker exec -i reimbursement-sso-postgres-1 psql -U reimbursement -d reimbursement -v ON_ERROR_STOP=1 -q; if ($LASTEXITCODE -ne 0) { throw "Go migration failed: $($_.Name)" } }
```

`prisma migrate deploy` 在宿主机运行时使用 `.env.local` 的 `DATABASE_URL`。首次启动需要等待 OCR 镜像与模型准备。打开 `http://localhost:8088/claims`。报销项目的 Go API 只在 Compose 内网暴露；BFF 和 Go 在每次受保护请求时查询 SSO，查询失败时拒绝访问。

从 Next.js Web 切到 Go 认证后，旧浏览器会话不会迁移；首次打开 React 工作台请重新登录。普通 Compose 启动不会运行 `web`。需要临时启动旧入口时，单独使用 `docker compose --env-file .env.local -p reimbursement-sso --profile legacy-web up -d web`；它仍使用本机 `localhost:3000`。回滚网关时需将 `infra/nginx/reimbursement-routes.conf` 的 `$auth_bff_upstream` 指回 `web:3000`，然后重建 `reimbursement-edge`。Node Worker 服务无需切换。

## 验收

1. 用测试企业成员访问 React 工作台，完成飞书登录，确认姓名与报销项目员工记录正确。另一个成员请用独立浏览器会话验证。
2. 在演示项目 A/B 中登录同一成员，确认三个项目共享 SSO 登录。
3. 在 React 工作台点“退出所有项目”；刷新两个演示项目，均应退出。再从演示项目退出，刷新 React 工作台应重新登录。
4. 退出前复制的短期 Web JWT 在 Go API 上也必须立即返回 401。SSO Go 服务停止时，React BFF 和 Go Web API 应拒绝受保护请求。飞书机器人和 Agent 专用令牌不受这次 React 身份接入影响。

后端退出通知用于加快本地会话删除；Go 对 SSO `sid` 的逐次查询负责保证通知延迟时旧 JWT 仍不可用。`reimbursement-web` 的回调、退出后地址和后端退出地址分别为 `http://localhost:8088/api/auth/sso/callback`、`http://localhost:8088/logged-out`、`http://host.docker.internal:8088/api/auth/sso/backchannel-logout`。

如果浏览器仍保留接入前的演示项目 SSO 登录，先在演示项目退出并重新通过飞书登录一次，使 SSO 写入该成员的企业身份映射。新 SSO 应用的飞书 `open_id` 可能与报销项目原飞书应用不同；需要管理员或财务复核员身份时，在本项目 `.env.local` 的角色名单中填写新应用对应的 `open_id`。
