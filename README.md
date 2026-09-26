# AI Reimbursement Agent

面向中国单企业员工报销场景的 AI 报销单服务。员工上传发票后，系统会安全保存附件、提取结构化字段、识别重复票据，并在信息不完整或可信度不足时要求用户补充确认。

## 当前能力

- 通过签名服务端会话创建和读取员工自己的报销草稿
- 版本号保护草稿更新，避免并发覆盖；所有创建与上传都会写入审计事件
- 仅接收 JPEG、PNG、PDF（最大 20MB；PDF 最多 20 页），校验文件签名并接入 ClamAV 扫描
- 使用私有 S3/MinIO 对象键存储附件，不提供匿名下载路径
- 通过可替换的票据识别 Provider 提取发票号、日期、金额、税额和销售方；本地默认使用 Fixture Provider
- 对重复文件哈希和同员工已提交的同发票号生成阻断性校验结果，且不重复计入费用

## 本地运行

```powershell
Copy-Item .env.example .env.local
docker compose up -d postgres minio clamav
npm install
npx prisma generate --config prisma7.config.ts
npm run dev
```

本机 Windows 若阻止 Prisma 原生迁移引擎，请在 Linux 容器中执行迁移；仓库内已提交 `prisma/migrations/`，应用环境可直接使用这些迁移。

本地服务端口：PostgreSQL `5433`、MinIO API `9000`、MinIO Console `9001`、ClamAV `3310`。

## AI 报销 Agent 模型配置

本地默认 `MODEL_PROVIDER="fixture"`，只用于开发和自动测试。接入 OpenAI-compatible 服务时，在未提交的 `.env.local` 中设置以下值，然后重启 `npm run dev`：

```dotenv
MODEL_PROVIDER="openai-compatible"
MODEL_BASE_URL="https://<provider>/v1"
MODEL_NAME="<model-name>"
MODEL_PROVIDER_API_KEY="<secret>"
MODEL_TIMEOUT_MS="20000"
```

`MODEL_BASE_URL` 应以兼容 Chat Completions 的 `/v1` 为结尾。服务端只会发送当前消息、脱敏后的草稿摘要和校验项；密钥不会发送到浏览器或写入日志。模型不可用时，员工仍可通过工作台直接补齐字段。

## 验证

```powershell
npm exec vitest -- run
npm exec tsc -- --noEmit
npm run lint
```

集成测试使用 Docker PostgreSQL：`postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement`。运行测试前先启动 `docker compose up -d postgres`。

## 身份登录（飞书 OAuth）

开发阶段可以先使用个人飞书账号完成 OAuth 授权。请在飞书开放平台创建自建应用，配置重定向地址为本地 `FEISHU_REDIRECT_URI`（默认 `http://localhost:3000/api/auth/feishu/callback`），然后在 `.env.local` 填入：

```dotenv
SESSION_SECRET="请替换为随机长字符串"
FEISHU_APP_ID="cli_..."
FEISHU_APP_SECRET="..."
FEISHU_REDIRECT_URI="http://localhost:3000/api/auth/feishu/callback"
```

访问 `GET /api/auth/feishu/login` 会跳转到飞书授权页；回调成功后，系统使用飞书 `open_id` 映射或创建本地员工，并写入 HttpOnly 会话 Cookie。

没有可用飞书应用配置时，仅本地开发可使用 `POST /api/auth/dev-login`。它只读取 `DEV_DEMO_EMPLOYEE_ID` 和 `DEV_DEMO_EMPLOYEE_NAME` 两个服务端环境变量，绝不接受浏览器提供的员工身份；生产环境始终返回 404。`POST /api/auth/logout` 会清除会话和临时 OAuth state Cookie。

## 后续流程

AI 对话只会提出字段建议，员工在工作台点击“接受并写入”后才会更新草稿；建议确认受草稿版本保护并记录审计。聊天框也可以上传票据，使用与票据区域完全相同的安全扫描、私有存储和 OCR 链路。

飞书等 IM 通道会复用同一套应用层用例和服务端身份边界，复杂字段确认和最终提交仍统一回到 Web 工作台。

## 飞书机器人 Worker

机器人使用独立的长连接 Worker，而不是 Web 回调地址。启用后，单聊消息和群聊 `@机器人` 消息会先持久化，再复用相同的草稿、附件安全扫描、MinIO、OCR、Agent 与校验流程；字段确认、删除和提交仍只能在 Web 工作台完成。

```dotenv
FEISHU_BOT_ENABLED="true"
FEISHU_BOT_OPEN_ID="ou_..."
FEISHU_EVENT_DELIVERY="long_connection"
APP_PUBLIC_URL="https://reimbursement.example.com"
```

开发环境分别运行 Web 与 Worker：

```powershell
npm run dev
npm run feishu:worker
```

容器部署使用同一镜像运行两个服务：

```powershell
docker compose up -d --build web feishu-bot-worker
```

容器中的 `.env.local` 应使用 `postgres`、`minio`、`clamav` 和 `ocr` 作为服务主机名；`APP_PUBLIC_URL` 在多人或移动端必须是员工可访问的 HTTPS 地址。完整开放平台配置、恢复措施与测试清单见 [飞书集成说明](docs/feishu-integration.md) 和 [运维说明](docs/operations.md)。
