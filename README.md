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
npm exec prisma generate --config prisma7.config.ts
npm run dev
```

本机 Windows 若阻止 Prisma 原生迁移引擎，请在 Linux 容器中执行迁移；仓库内已提交 `prisma/migrations/`，应用环境可直接使用这些迁移。

本地服务端口：PostgreSQL `5433`、MinIO API `9000`、MinIO Console `9001`、ClamAV `3310`。

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

下一阶段将补齐字段来源与置信度校验、用户澄清、提交前预览/确认，以及 Web 对话式报销界面。飞书等 IM 通道会复用同一套应用层用例和服务端身份边界。
