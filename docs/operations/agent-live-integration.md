# Agent 链路验收

## 自动验收

在仓库根目录运行：

```powershell
docker compose up -d postgres
docker compose --profile migration build reimbursement-api
npm run test:agent:live
npm run eval:agent -- fixture --repeat 3
npm run eval:agent -- real --repeat 3
```

`test:agent:live` 需要 Docker Desktop、`.env.local` 中本机 `DATABASE_URL`（`localhost:5433`）、Go Agent 签名密钥、服务密钥和员工投影密钥。脚本生成两个名称带 `agent_p0_` 前缀的临时 PostgreSQL 数据库，执行 Prisma 与 Go 迁移，启动仅监听 `127.0.0.1` 随机端口的临时 Go API，运行集成测试，然后停止该容器并删除**仅由本次脚本创建**的数据库。不会清空 `reimbursement`、`reimbursement_test` 或 `reimbursement_go_test`。若测试失败，脚本仍会清理；失败信息会遮盖环境中的密钥和数据库 URL。

该集成测试走真实的飞书事件接收/排队/回复运行时、Prisma 事件和会话仓储、员工投影、Agent 工具网关、Go HTTP 认证和 Go 数据库。它检查新建办理、写入事由、读取草稿、未满足条件时拒绝提交、另一员工无法查询以及重复事件只处理一次。飞书平台 HTTP/长连接和意图模型在此测试中是受控替身；真实模型由 `eval:agent -- real` 独立验证。完整集目前 18 个案例、21 轮，其中 4 个自测案例和 14 个合成案例，没有员工脱敏样本。三轮都通过且安全误写为零才可记录为模型回归通过；模型连接失败属于环境失败，不能算准确率。

## 飞书平台与业务环境现场验收

多人演练先准备固定 HTTPS 域名，确保 `APP_PUBLIC_URL`、飞书 OAuth 回调与浏览器访问地址一致；临时 `trycloudflare` 域名只适合个人临时调试。使用两个不同 `open_id` 的测试员工 A、B，准备一张允许用于测试的票据，不要在验收记录中保存原始发票或聊天全文。

1. 确认 `web`、`feishu-bot-worker`、`agent-event-worker`、`reimbursement-api`、`reimbursement-worker`、`ocr`、`postgres`、`minio` 均运行。飞书 Worker 日志应出现 `worker.started`，真实消息应出现投递完成事件。
2. A 私聊问一条已同步政策，核对回答、章节引用和原文；Web 单据列表不应因此新增草稿。再问一条未同步政策，不能编造依据。
3. A 私聊“新建报销”，补事由并上传票据；在 React 工作台核对同一个单号、票据和异步 OCR 状态。OCR 完成后核对金额、发票号和只发送一次的通知。测试识别失败时，回复不能声称识别成功。
4. B 用 A 的单号查询、编辑和请求提交，均不得获得 A 的个人数据或产生写入。群聊未 `@机器人` 不回应；`@机器人` 后也不能展示个人单据或金额。
5. A 在 Web 补齐当前对话不能填写的金额、币种和备注，私聊请求提交前摘要。确认摘要仍为草稿；只有回复精确“确认提交”后才应提交一次。Web 改字段或票据后，旧确认必须失效。
6. 在演练环境分别中断模型和 Go API，确认机器人只给失败/重试提示，不声称写入成功；恢复后重新发消息可以继续。不要在生产数据上做故障演练。

记录每步的时间、脱敏单号、事件 ID、Web/Go 状态、预期与实际结果，以及失败码；不要记录飞书 `open_id`、原始发票、模型密钥或会话原文。自动验收与现场验收分别签字，不能用前者代替飞书平台、OCR、知识库和真实员工权限验收。

本地启动飞书 Worker 前先运行 `npx prisma migrate status --config prisma7.config.ts`。如果提示迁移未应用，运行 `npx prisma migrate deploy --config prisma7.config.ts` 后重启 Worker。2026-10-29 的本地演练中，缺少 `20261028010000_feishu_reply_delivery` 会使 Worker 启动恢复查询遇到 PostgreSQL 枚举错误 `22P02`，表现为重复 `worker.failed`；应用迁移后日志出现 `worker.started` 和 `worker.heartbeat`。这仅证明 Worker 已连接并运行，仍需按上面的现场步骤发送真实飞书消息验收业务链路。
