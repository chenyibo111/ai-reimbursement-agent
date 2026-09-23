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

## 后续流程

下一阶段将补齐字段来源与置信度校验、用户澄清、提交前预览/确认，以及 Web 对话式报销界面。飞书等 IM 通道会复用同一套应用层用例和服务端身份边界。
