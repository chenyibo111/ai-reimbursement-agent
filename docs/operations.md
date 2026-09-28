# 运维说明

数据库结构升级：

```powershell
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
```

## 政策规则发布与恢复

部署政策功能前，先备份 PostgreSQL，再在目标环境执行已提交的 Prisma 迁移；不得通过重建数据库卷或删除 `PolicyVersion` / `SubmissionSnapshot` 来“初始化”政策数据。部署后在未提交的密钥环境文件中配置管理员白名单：

```dotenv
POLICY_ADMIN_FEISHU_OPEN_IDS="ou_finance_a,ou_finance_b"
```

仅格式正确的 `ou_...` 飞书 `open_id` 会被接受。空白、重复或无效值不会授予权限；白名单为空时是安全的只读状态，不会影响员工报销草稿和基础校验。该白名单仅是角色迁移期间的兼容方案；完成首次管理员初始化后，角色以数据库 `Employee.role` 为准。

发布前由管理员在 `/admin/policies` 核对草稿规则、规则级别和生效日期。`BLOCKING` 会阻止确认与提交，`WARNING` 仅提示但会留在确认摘要和提交快照中。发布后不能直接修改版本；若需要撤回或修正制度，创建一份新的草稿并发布。这样会归档旧的已发布版本，但不会改写已提交报销单中的政策快照。

应用回滚只回滚应用镜像或执行经验证的数据库恢复流程；不要删除迁移记录、政策审计或提交快照。若新版本政策不应继续生效，优先发布一份经核对的替代版本；在没有有效发布版本时，系统仍保留基础校验，不会把员工提交视作已符合政策。

本地开发使用 `MODEL_PROVIDER="fixture"`。生产必须设置 `MODEL_PROVIDER="openai-compatible"`、`MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_PROVIDER_API_KEY` 和可选 `MODEL_TIMEOUT_MS`。

模型异常时，聊天接口返回可恢复错误，员工仍可通过工作台字段编辑继续处理。暂停真实模型时，将 `MODEL_PROVIDER` 切换为本地 Fixture 并重启服务；不要删除既有建议或审计记录。

重点监控：OCR 失败率、上传安全扫描失败、模型 `TIMEOUT`/`UNAVAILABLE`、`MODEL_RESPONSE_REJECTED`、建议确认版本冲突和提交前阻断项数量。日志不得记录 API Key、对象键、原始票据内容或完整提示词。

## 异步任务与人工复核运行

部署前先执行 Prisma 迁移，再启动 `web`、`feishu-bot-worker` 与 `job-worker`。三个进程必须使用同一份受控密钥环境和同一 PostgreSQL 数据库；`job-worker` 领取 OCR 与政策来源同步任务，Web 只负责创建和查询任务。

```powershell
docker compose up -d --build web feishu-bot-worker job-worker
docker compose logs -f job-worker
```

首次启用数据库角色时，确认目标员工 ID 后执行一次：

```powershell
npm run roles:bootstrap -- <employeeId>
```

该命令只在尚无管理员时提升指定员工，避免无意扩大权限。之后仅管理员可修改角色；系统拒绝移除最后一个管理员。

任务状态含义如下：`PENDING` 等待领取，`RUNNING` 正在执行并持有 lease，`RETRY_WAIT` 按 1/5/30 分钟退避，`SUCCEEDED` 已完成，`REVIEW_REQUIRED` 需要人工判断，`CLOSED` 因目标不存在或明确关闭而终止。Worker 重启会回收过期 lease；不要通过直接修改任务状态或删除任务来“重试”。

OCR 低置信度、重复票据和重试耗尽会创建 `RECEIPT_OCR` 复核任务，由财务复核员领取。更正字段时系统校验报销单版本、写入审计事件；若发生冲突，刷新任务和报销单后重新判断。政策同步重试耗尽会创建 `POLICY_SYNC` 任务，仅管理员可重新排队。员工端不显示失败码、对象键或原始错误。

排障顺序：先确认 `docker compose ps` 中 `job-worker` 正在运行，再查看 `docker compose logs --tail=200 job-worker`；随后检查依赖服务健康与任务的安全状态/失败分类。不可通过清空 `AsyncJob`、`ReviewCase` 或迁移记录恢复服务；先修复 OCR、Embedding、数据库或飞书依赖，再让 Worker 按既有退避和复核流程处理。

政策监控另包括：管理员 `403` 比例、草稿保存/发布版本冲突、发布审计事件、政策阻断与预警数量、以及无有效发布政策的持续时长。日志不得记录飞书 App Secret、完整规则配置、员工票据或向量内容。

## 政策知识库运行

先备份 PostgreSQL，再部署 pgvector 迁移；不得重建 `postgres-data` 卷。Embedding 服务使用 `knowledge` Compose profile 和 `embedding-models` 缓存卷，生产环境仅通过 Docker 内网访问，不得发布主机端口。开发机以宿主机运行 Web 时，可叠加 `docker-compose.local.yml`，将端口仅绑定到 `127.0.0.1:8081`，并使用 CPU PyTorch；该覆盖文件不得用于生产。首次同步会下载 BGE-M3 模型；生产 GPU 可使用独立构建的 GPU 镜像及 `docker-compose.gpu.yml`。来源同步失败时保留最近活动快照，排查时只记录来源 ID 与安全错误分类，不记录文档正文、token 或向量。

## 飞书机器人运行

启动前执行 `npm run feishu:worker` 所需的环境校验：`FEISHU_BOT_ENABLED=true`、飞书 App 凭据、机器人 `open_id`、`APP_PUBLIC_URL`、数据库、MinIO、ClamAV 和 OCR 地址均必须完整。生产环境的 `APP_PUBLIC_URL` 必须为 HTTPS。

长连接回调仅持久化事件 ID、消息 ID、会话 ID、发送者 `open_id` 和状态，不记录原始飞书事件包、附件字节、对象键或 access token。规范化的用户文本与助手安全回复保存在员工会话中，用于跨 Web/飞书私有历史回放；会话不是草稿事实来源，金额、票据、版本与提交状态始终从 Intake/ClaimDraft 重新读取。Worker 会领取 `PENDING` 与安全可重试事件；已完成业务即使飞书回复失败也不会回滚草稿、附件或已保存会话消息。

容器部署：

```powershell
docker compose up -d --build web feishu-bot-worker
docker compose logs -f feishu-bot-worker
docker compose restart feishu-bot-worker
```

Worker 重启后会恢复未领取或可安全重试的事件。若 OCR、病毒扫描或对象存储不可用，先恢复相应依赖，再在 Web 工作台确认草稿和附件状态；不要通过删除数据库事件来“重试”。

### 跨渠道会话迁移、留存与回滚

部署包含 `AgentConversation`、`AgentMessage` 和 `ReimbursementIntake` 的版本时，先备份 PostgreSQL，再执行 `npx prisma migrate deploy --config prisma7.config.ts`，随后同时滚动重启 `web` 与 `feishu-bot-worker`。Worker 与 Web 必须连接同一数据库，才能让员工私有 Web 会话和飞书单聊共享历史。群聊按员工和群聊 ID 隔离，排障时不得把群聊消息导出到员工私有会话或日志。

会话、消息和 Intake 随员工删除级联清理；删除草稿只会将关联 Intake 的草稿引用置空，不删除会话历史。不要通过清空会话表来处理单一失败：对于 OCR/模型/回复失败，保留已保存消息和 Intake，以服务端安全错误分类提示重试或回到 Web。需要缩短留存期时，应先制定员工、审计和政策依据的保留策略并经数据负责人审批，再执行可验证的分批清理。

应用回滚只能回滚应用镜像；已经执行的会话迁移保持在数据库中，不回退或手改 Prisma 迁移记录。旧 Worker 版本不认识新会话契约，因此发布后如必须回滚，应先停止 Worker、回滚 Web 与 Worker 到同一兼容版本，并验证没有待领取的飞书事件，再恢复长连接。

发布前在测试企业逐项核对：发布应用版本；单聊文本；群聊仅 `@机器人`；JPG/PNG/PDF；未绑定 OAuth 用户；相同消息重投；Worker 重启；飞书下载、OCR、模型和回复失败；以及 Web 仍是建议确认、删除和提交的唯一入口。自动化测试只使用伪造飞书消息和附件，不使用真实 App Secret 或真实发票。
