# Next.js 退役验收记录

记录日期：2026-11-06。环境：本机 Windows + Docker Desktop，Compose 项目 `reimbursement-sso`，入口 `http://localhost:8088`。本记录区分已自动验证的结果和仍需企业账号现场操作的项目；不包含密钥、员工标识、票据内容或会话正文。

## 已验证

| 范围 | 方法 | 实际结果 |
| --- | --- | --- |
| 数据迁移 | 升级前备份本机 PostgreSQL；`prisma migrate status` 核对待部署项，`migrate deploy` 应用两条新增迁移 | 备份文件为有效 PGDMP；迁移部署成功。备份留在本机 `D:\AI\_local-backups\reimbursement-before-next-retirement-20261106.dump`，不提交仓库 |
| 现有数据 | 只读查询 Go 单据/票据和 Prisma 政策来源表的记录数 | 当前库有 4 条单据、2 条票据、0 条政策来源；记录仍可读取。附件对象内容未逐一下载核对 |
| Node | 完整 Vitest、ESLint、TypeScript | 91 个测试文件通过、1 个跳过；453 个测试通过、1 个跳过；Lint 与 `tsc --noEmit` 通过 |
| Go | `go test ./...`，在容器中挂载整个仓库以供 OpenAPI 契约测试读取 | 所有包通过 |
| React | `npm test --prefix apps/web -- --run`、`npm run build --prefix apps/web` | 12 个文件、61 个测试通过；Vite 构建通过 |
| 配置 | `docker compose --env-file .env.local --profile migration --profile knowledge --profile observability config -q`；在临时空目录复制根包清单并执行 `npm ci --ignore-scripts` | Compose 配置有效；干净安装成功（390 个包），临时目录已删除。Prisma 生成和服务镜像另行验证 |
| Worker 镜像 | 重建并检查最终 `feishu-bot-worker` 镜像 | 大小 180,452,368 字节；无 `.next`、`public`、`next`、`react`；`tsx`、Prisma Client 可解析。相较旧镜像 367,989,535 字节减少约 51% |
| 进程 | Compose `ps` 和启动后日志 | `reimbursement-api`、`reimbursement-web`、`reimbursement-edge`、`agent-admin`、飞书/任务/事件 Worker、日志平台等均运行；Agent 管理服务仅容器内 8083，飞书与任务 Worker 有心跳 |
| 边缘入口 | 未登录 HTTP 探测 | `/claims` 与 `/admin/policy-sources` 返回 React HTML 200；`/api/auth/access-token` 与 `/api/v1/admin/policy-sources` 返回 401；旧 `/api/admin/policy-sources` 和 `/api/claims` 明确返回 404 |
| 路由与引用 | Next 退役契约测试、旧测试归属清单、生产源码/Compose/CI 静态检索 | 旧 `app/`、Next 配置/依赖/构建目标已清理；当前生产路径无 Next 导入。历史文档保留历史说明 |

旧路由 `/policies` 与 `/claims/{id}/detail` 由 React 提供明确的停用/迁移提示；此显示依赖登录，已由组件测试覆盖，尚未用真实浏览器会话现场确认。旧 `/api/*` 由 Nginx 拦截；当前 `/api/auth/*` 和 `/api/v1/*` 仍分别路由到 Go。

## 仍需现场验收

当前没有可复用的已登录浏览器会话，本机数据库也没有可同步的政策来源。下表需管理员及两名测试企业员工用真实飞书/SSO 环境完成，并填写非敏感的单号、任务 ID、时间与结果。通过前不把 Task 7 标为完成。

| 场景 | 操作与预期 | 结果 |
| --- | --- | --- |
| 管理员来源 | 管理员登录 `/admin/policy-sources`，新增已授权 Docx/Wiki，启停、请求同步；页面显示排队、成功或未变化，刷新后保留最近任务状态 | 待验收 |
| 权限拒绝 | 普通员工及财务复核员访问来源 API 为 403；撤销 SSO 后为 401；浏览器伪造管理员头不生效 | 待验收；Go 自动化测试已覆盖这些分支 |
| 来源失败与恢复 | 同步无权限文档和不可用 Embedding；展示安全失败分类，活动快照不消失；Worker 重启、重复同步后状态可查 | 待验收；Agent 自动化测试已覆盖关键状态 |
| 政策问答 | 同步成功后用飞书查询政策，检查回答中的证据与当前文档一致；发布 Go 规则后检查提交提示/阻断 | 待验收 |
| 员工 A | SSO 登录，创建、上传、OCR、查看本人单据，提交并核对快照；飞书查询本人单据及确认提交 | 待验收 |
| 员工 B | 另一企业成员登录并操作本人单据，尝试读取/编辑员工 A 单据应被拒绝；飞书群聊不得泄露本人数据 | 待验收 |
| 财务复核 | 使用财务账号领取低置信度票据复核，确认/要求重传/关闭后核对员工单据页面状态 | 待验收 |
| 附件持久性 | 下载一份升级前附件，并核对升级后 MinIO 对象可读、字节数与内容摘要一致 | 待验收 |

现场记录模板：`时间 / 测试员工代号 / 单号或任务 ID / 预期 / 实际 / 请求或日志关联 ID / 结论`。不要记录 `open_id`、密钥、发票原文或完整聊天内容。

## 故障恢复

先查 `docker compose --env-file .env.local --profile migration --profile knowledge --profile observability ps` 和相关服务日志。政策来源失败按来源 ID 与 job ID 检查 `agent-admin`、`job-worker`、`reimbursement-api`；登录失败检查 Go Auth BFF 与独立 SSO；旧 API 404 属预期退役行为。应用可回退到兼容数据库迁移的镜像；不要回滚已执行的 Prisma 迁移、删除卷或清空任务/政策快照。数据库恢复仅使用上述本机备份和既有受控恢复流程。
