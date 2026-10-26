# Agent 字段写入与本人单据查询验收

本功能通过现有 Go 工具网关工作。先对目标环境运行已提交的 Prisma 迁移，再重建并启动 Web、Agent/飞书 Worker 与 Go API；确认 Go 报销 API 可用。不要把测试环境的两名员工共用同一飞书 `open_id`。

本机在仓库根目录执行（保留现有 `.env.local` 和数据卷）：

```powershell
docker compose up -d postgres
npx prisma migrate deploy --config prisma7.config.ts
docker compose --profile migration up -d --build web feishu-bot-worker reimbursement-api reimbursement-web reimbursement-edge
docker compose ps web feishu-bot-worker reimbursement-api reimbursement-web reimbursement-edge
```

浏览器统一从 `http://localhost:8088/claims` 进入；确认各服务处于 `Up`，且飞书私聊机器人能回复。若本机只验证 Web 私有会话，可先不启动 `feishu-bot-worker`。不要仅重启旧容器而不重建镜像，否则验收的仍是旧代码。

1. 员工 A 在 Web 私有会话或飞书私聊说“开始报销”，检查仅建立 Intake、未建立 Go 草稿。再明确提供报销事由、费用类别、参与人员和项目编号。回复应为“已保存到报销草稿”，Go 工作台和 Web 页面刷新后字段应完全一致。金额、币种、备注的对话代填请求应引导去 Web，且不得声称已保存。
2. 员工 A 说“我的报销单”，应最多看到五张本人单据的单号、状态、事由。提供一张较早的完整 `BXYYYYMMDD-序号` 单号，再追问“这单金额/状态”；每次都应以 Go 当前本人数据回答。员工 B 输入同一单号，与不存在的单号得到同样的安全未找到回复。
3. 保持员工 A 的当前 Intake，显式查询另一张旧单，再补充当前报销事由。旧单应只被读取，补充字段仍写当前 Intake 对应的草稿。任何准备提交及精确的“确认提交”也只能作用于当前 Intake。飞书群聊询问本人列表或单据详情时不得返回私有信息。
4. 准备提交后再修改允许字段，旧确认令牌应失效，必须重新发起提交准备。另在 Web 先修改同一草稿，模拟版本冲突：若 Go 回读值与 Agent 提案不同，Agent 不得覆盖 Web 更新，也不得回复“已保存”；若 Web 已写入完全相同的值，可回读确认成功。Go 写入后回读失败时应提示“未确认写入”，要求到工作台核对。
5. 使用同一个飞书事件 ID 或 Web `turnId` 重放一次补字段消息，Go 草稿和 PATCH 不得重复创建/执行。重新发送一条不同的新消息则应按当前 Go 版本处理。
6. 新建一笔尚未填写参与人员的 Go 草稿，“我的报销单”和按完整单号查询都应正常返回；查询不存在的单号后再说“这单”，不得沿用上一次选择的旧单。对升级前只写在会话、未写进 Go 草稿的字段，首次接触应提示未保存并要求重新确认，而不是当作已保存。

自动化检查：根目录 `npm test`、`npm run lint`、`npx tsc --noEmit`、`npm run build`；`apps/web` 下 `npm test` 与 `npm run build`；`services/agent` 下 `npm test`；Go 使用**隔离测试库**运行 `go test ./...`。模型真实调用评测可能计费，只有明确允许后才运行 `npm run eval:intent`。浏览器与飞书双员工验收需在具备有效 OAuth、Go API 和机器人长连接的环境中手动执行。
