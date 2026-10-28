# Agent 本人单据检索、办理与通知验收

本功能通过现有 Go 工具网关工作。先对目标环境运行已提交的 Prisma 迁移，再重建并启动 Web、Agent/飞书 Worker 与 Go API；确认 Go 报销 API 可用。不要把测试环境的两名员工共用同一飞书 `open_id`。

本机在仓库根目录执行（保留现有 `.env.local` 和数据卷）：

```powershell
docker compose up -d postgres
npx prisma migrate deploy --config prisma7.config.ts
docker compose --profile migration up -d --build web feishu-bot-worker agent-event-worker reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
docker compose ps web feishu-bot-worker agent-event-worker reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
```

React + Go 报销工作台从 `http://localhost:8088/claims` 进入；本轮的 Web 私有 Agent 对话入口仍是旧 Next 界面的 `http://localhost:3000/claims` 悬浮“报销助理”，**React 页面目前没有该聊天悬浮入口**。两者共用同一个 `localhost` 登录 Cookie，但端口和页面不同。确认各服务处于 `Up`，且飞书私聊机器人能回复。若本机只验证 Web 私有会话，可先不启动 `feishu-bot-worker`。不要仅重启旧容器而不重建镜像，否则验收的仍是旧代码。

1. 用员工 A 的飞书私聊说“开始报销”，检查仅建立 Intake。补充事由、费用类别、参与人员、项目编号后，Go Web 工作台刷新应一致。申请金额、币种、备注必须在 Web 表单填写；Agent 不得声称代填成功。
2. 准备至少 101 张员工 A 单据与一张员工 B 单据。在飞书问“上个月草稿按申请金额从高到低列 12 张”，检查匹配总数、首批序号与“下一页”；翻页后应能找到第 101 张旧单。`http://localhost:8088/claims` 使用同样状态、日期、事由、费用类别、金额和排序筛选，显示同样的 Go 总数，继续加载后能打开旧单。
3. 员工 A 用完整单号查询旧单 A，再明确说“编辑 BX…”。旧单 A 必须属于本人且为草稿才可设为办理目标；当前 Intake 草稿 B 保留。只读查询 A 后提“改这张”，或读目标与办目标冲突时，必须澄清而不写入任何草稿。员工 B 查询/编辑员工 A 的单号，应得到与不存在单号相同的安全回复；群聊不得透露列表、金额或旧单是否存在。
4. 在明确选中的旧草稿上传发票，等 OCR 完成或转人工复核；飞书私聊通知应指向旧草稿，不指向活动 Intake。问“这张还缺什么”，应只显示 Go 当前票据、校验、人工复核状态；审批和付款显示“未接入”。财务处理复核后，应收到一次基于 Go 当前状态的通知；重复投递同一事件不重复发送。
5. 对旧草稿更正事由或其他允许字段，Web 刷新核对。删除票据、删除草稿均需明确单号/票据和一次性确认；非草稿不能删除。删除后，Web 和 Agent 列表都不再显示该草稿。新文件上传失败时不能删除原票。
6. 对选中的旧草稿请求提交前摘要，检查 Go 最新版本/金额/阻断项，明确回复“确认提交”后再看 Web 状态。改字段、上传/删除票据、切换目标或 Web 并发修改后，旧确认应失效；重新准备后才能提交。飞书群聊、员工 B、已提交单、过期确认均不能提交员工 A 的旧单。
7. 重放相同飞书事件 ID 或 Web `turnId`，确认不重复写入/通知。若当前 `APP_PUBLIC_URL` 是 `localhost`，飞书只应给单号和文字指引，不应发无法从飞书打开的 localhost 链接；有可访问的 HTTPS 公开地址时才附准确工作台链接。

自动化检查：根目录 `npm test`、`npm run lint`、`npx tsc --noEmit`、`npm run build`；`apps/web` 下 `npm test` 与 `npm run build`；`services/agent` 下 `npm test`；Go 使用**隔离测试库**运行 `go test ./...`。Go 仓储测试覆盖 105 张本人单据、另一个员工、完整游标遍历、页码直达与旧单保留；React 测试覆盖筛选参数、总数和页码跳转。模型真实调用评测可能计费，只有明确允许后才运行 `npm run eval:intent`。浏览器 OAuth 和飞书双员工现场验收需在有两名有效员工、机器人长连接与当前公开域名的环境执行，并记录实际单号与事件 ID。
