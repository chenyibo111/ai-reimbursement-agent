# 运维说明

数据库结构升级：

```powershell
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
```

## Go 报销迁移与灰度

迁移顺序固定为：备份旧库、只读导出、导入 Go 报销库、执行对账、再按员工和渠道逐步切流。禁止双写，撤回开关只影响尚未创建的新单据；已由 Go 创建的单据继续由 Go 管理。

```powershell
# 旧 Prisma 数据库：只读导出 JSONL，输出文件不得提交或上传到非受控位置
npm run migration:export-legacy > legacy-claims.jsonl

# Go 目标数据库：从标准输入幂等导入（同一 claim ID 重跑会跳过）
Get-Content legacy-claims.jsonl | docker compose --profile migration run --rm --entrypoint /usr/local/bin/legacy-import reimbursement-api
```

每个批次先在内部测试员工及指定渠道启用反向代理开关。只有单据数、状态、金额、票据内容哈希和提交快照摘要的对账全部无差异，才允许扩大范围。若发现差异，立即关闭该范围的新流量；不要反向同步、删除 Go 数据或修改旧库记录。

### 报销单号与票据识别字段升级

`services/reimbursement-api/db/migrations/000010_claim_numbers_and_receipt_metadata.sql` 是 Go `reimbursement` schema 的前向升级：它回填已有报销单的不可变 `claim_number`，新增每日序号计数器，并增加可空的 `invoice_date`、`total_amount_cent`、`seller_name`。金额单位为分；空值代表没有可靠识别结果，绝不代表零金额。

执行前必须完成并验证目标 PostgreSQL 备份。不要以删除 Docker volume、重建数据库、手改报销单号或直接填充 OCR 字段代替迁移。由拥有 DDL 权限的受控运维账户执行已提交脚本；本地 Compose 环境可使用：

```powershell
Get-Content -Raw services/reimbursement-api/db/migrations/000010_claim_numbers_and_receipt_metadata.sql |
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement
```

脚本成功后，同步重启迁移 Profile 的读写路径，避免新 API、Worker 和 React 对同一 schema 版本理解不一致：

```powershell
docker compose --profile migration up -d --build reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
docker compose --profile migration ps
```

验收使用测试员工和非敏感样票完成以下检查：

1. 新建草稿后，列表和工作台都显示稳定的 `BXyyyyMMdd-xxxx`；刷新后不变。
2. 上传带明确标签的票据，识别完成后显示发票号码、开票日期、价税合计、销售方、置信度，以及以分精确聚合的已识别金额。
3. 打开一张历史或字段不完整的已识别票据；它仍可读取，缺失字段显示“待补充”，不会显示 `￥0.00`，也不会因为本次展示增强被新的校验规则阻断。
4. 运行既有提交前检查，确认提交状态机、重复票据校验和人工复核入口没有改变。

该迁移不支持通过删除列、删除计数器或修改迁移记录来回滚。应用故障时可先回退到仍兼容新增列的应用镜像；若必须恢复数据库状态，只能按已验证的 PostgreSQL 备份恢复流程执行，并先停止对应写入流量。恢复后重新核对报销单号、票据记录、审计事件和提交快照，不能反向同步或删除单笔记录“修复”。

### 申请报销金额、币种与备注升级

`services/reimbursement-api/db/migrations/000011_claim_application_fields.sql` 必须在 `000010` 之后执行。它为 `reimbursement.claims` 增加可空的 `requested_amount_cent`、固定为 `CNY` 的 `currency`、金额来源 `requested_amount_source` 与最长 1000 字符的 `remark`。金额单位为分；空金额表示员工尚未填写或尚无可用 OCR 建议，绝不代表零金额。

执行前备份目标 PostgreSQL，并由具备 DDL 权限的受控运维账户执行已提交脚本。不要手改字段、删除数据卷或以重建数据库代替迁移。本地 Compose 环境可执行：

```powershell
Get-Content -Raw services/reimbursement-api/db/migrations/000011_claim_application_fields.sql |
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement

docker compose --profile migration up -d --build reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
docker compose --profile migration ps
```

迁移后仅做只读核对，不记录或导出员工明细：

```sql
SELECT currency, requested_amount_source, count(*)
FROM reimbursement.claims
GROUP BY currency, requested_amount_source
ORDER BY currency, requested_amount_source;

SELECT claim_number, requested_amount_cent, currency, requested_amount_source, length(remark) AS remark_length
FROM reimbursement.claims
ORDER BY updated_at DESC
LIMIT 10;
```

验收一条测试草稿即可：无 OCR 金额时提交前检查应返回 `REQUESTED_AMOUNT_REQUIRED`；识别完成后，仍使用 OCR 建议的草稿应显示已识别票据金额合计；输入例如 `99.99` 并保存后，来源应为手工，后续 OCR 不得覆盖该金额；点击“恢复 OCR 建议金额”后应显示当前合计。币种在界面中只读显示为 CNY，金额最多两位小数，备注最多 1000 个字符。提交成功后，提交快照必须保留金额、币种、来源和备注。

此迁移为前向兼容变更：回退应用镜像时不删除列、不回填旧字段、不删除提交快照。若发布异常，停止扩大灰度范围并恢复兼容的应用镜像；数据库恢复仅使用发布前已经验证的备份流程。

### Go 政策规则版本升级

`services/reimbursement-api/db/migrations/000015_enforce_policy_rules.sql` 为 Go 政策版本增加结构化 `rules`，并允许按生效日期保留多个已发布版本。旧版本默认没有规则。升级前先备份目标 PostgreSQL；本地 Compose 环境按序执行尚未应用的 Go 迁移，然后执行：

```powershell
Get-Content -Raw services/reimbursement-api/db/migrations/000015_enforce_policy_rules.sql |
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement
docker compose --profile migration up -d --build reimbursement-api reimbursement-web reimbursement-edge
```

迁移与重启后，在财务政策页发布测试版本，分别验证阻断规则、仅提示规则以及未来生效版本；员工提交以 Go 校验结果为准。飞书制度文档同步只更新问答依据，不会自动发布或更改 Go 规则。城市住宿限额、单笔费用上限仍需人工核对。若回退应用镜像，数据库新增列可保留；不要删除已发布版本或提交快照。

## 政策管理与知识来源

Go Auth BFF 根据 `FEISHU_ADMIN_OPEN_IDS` 和企业成员身份签发管理员会话；Go API 每次管理请求重新核对当前数据库角色。`/admin/policies` 发布可执行规则，`/admin/policy-sources` 登记飞书 Docx/Wiki 来源。两者独立：来源同步更新问答证据，不会自动修改提交校验规则。规则版本发布后不能覆盖；修订时发布新版本，提交摘要保留当时的政策结果。

政策来源由 React 经 Go `/api/v1/admin/policy-sources` 调用内网 `agent-admin` 服务。Go 只转发经过认证的管理员 ID，并使用单独的 `AGENT_ADMIN_SERVICE_KEY`；该密钥只放在未提交的环境 Secret，不能写入浏览器响应或 URL。来源新增、启停、请求同步和任务结果均写审计事实。同步返回任务 ID 和排队状态；`job-worker` 执行后，管理页轮询任务并在刷新后从最近任务恢复状态。只有任务成功且存在数值时才显示索引数量；失败保留最近一次成功的活动快照。

运维排查：先检查 `agent-admin`、`reimbursement-api`、`job-worker` 和数据库，再根据来源 ID / job ID 查看安全失败分类。`DOCUMENT_UNAUTHORIZED` 需要核对飞书应用权限与文档授权；`EMBEDDING_UNAVAILABLE` 需要恢复向量化服务。不要删除来源、任务、审计或活动快照来重试。旧 `/api/admin/policy-sources` 路由和旧 Next 管理员白名单已退役；边缘代理对其他旧 `/api/*` 路径明确返回 404。

本地开发使用 `MODEL_PROVIDER="fixture"`。生产必须设置 `MODEL_PROVIDER="openai-compatible"`、`MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_PROVIDER_API_KEY` 和可选 `MODEL_TIMEOUT_MS`。

模型异常时，聊天接口返回可恢复错误，员工仍可通过工作台字段编辑继续处理。暂停真实模型时，将 `MODEL_PROVIDER` 切换为本地 Fixture 并重启服务；不要删除既有建议或审计记录。

重点监控：OCR 失败率、上传安全扫描失败、模型 `TIMEOUT`/`UNAVAILABLE`、`MODEL_RESPONSE_REJECTED`、建议确认版本冲突和提交前阻断项数量。日志不得记录 API Key、对象键、原始票据内容或完整提示词。

## 异步任务与人工复核运行

Agent 报销办理仅调用 Go API。部署前确认 Go API、NATS、MinIO 与 `REIMBURSEMENT_API_URL`、`REIMBURSEMENT_AGENT_SERVICE_KEY`、`REIMBURSEMENT_AUTH_HS256_SECRET` 已就绪；容器内预签名上传通过 `REIMBURSEMENT_AGENT_STORAGE_ENDPOINT` 访问 MinIO。Go 服务故障时先恢复服务，不能让 Agent 切换到旧 Prisma 报销写入路径；需要回滚时应整体回滚 Web、飞书 Worker 与 Go API 的兼容镜像版本。

部署前先执行 Prisma 迁移，再启动 `reimbursement-web`、`reimbursement-api`、`agent-admin`、`feishu-bot-worker` 与 `job-worker`。Node Worker 使用单独的运行依赖锁文件和镜像；`job-worker` 领取历史 OCR 与政策来源同步任务，React 经 Go 创建和查询任务。

```powershell
docker compose --env-file .env.local --profile migration --profile knowledge up -d --build reimbursement-web reimbursement-api agent-admin feishu-bot-worker job-worker
docker compose --env-file .env.local logs --tail=100 job-worker agent-admin
```

首次启用数据库角色时，确认目标员工 ID 后执行一次：

```powershell
npm run roles:bootstrap -- <employeeId>
```

该命令只在尚无管理员时提升指定员工，避免无意扩大权限。之后仅管理员可修改角色；系统拒绝移除最后一个管理员。

任务状态含义如下：`PENDING` 等待领取，`RUNNING` 正在执行并持有 lease，`RETRY_WAIT` 按 1/5/30 分钟退避，`SUCCEEDED` 已完成，`REVIEW_REQUIRED` 需要人工判断，`CLOSED` 因目标不存在或明确关闭而终止。Worker 重启会回收过期 lease；不要通过直接修改任务状态或删除任务来“重试”。

OCR 低置信度、重复票据和重试耗尽会由 Go API 原子创建或复用 `reimbursement.review_cases` 中的 `RECEIPT_OCR` 复核案件，由财务复核员领取。案件领取和处理均带版本号；若发生冲突，刷新案件后重新判断。`CORRECT_FIELDS` 会再次校验已提交报销单的发票号；`REQUEST_REUPLOAD` 与 `CLOSE_INVALID` 只隔离票据，不会删除原始审计事实。政策同步重试耗尽仍使用 `AsyncJob` 的 `POLICY_SYNC` 任务，仅管理员可重新排队。员工端不显示失败码、对象键、复核原因或处理说明。

排障顺序：先确认 `docker compose ps` 中 `job-worker` 正在运行，再查看 `docker compose logs --tail=200 job-worker`；随后检查依赖服务健康与任务的安全状态/失败分类。不可通过清空 `AsyncJob`、`ReviewCase` 或迁移记录恢复服务；先修复 OCR、Embedding、数据库或飞书依赖，再让 Worker 按既有退避和复核流程处理。

政策监控另包括：管理员 `403` 比例、草稿保存/发布版本冲突、发布审计事件、政策阻断与预警数量、以及无有效发布政策的持续时长。日志不得记录飞书 App Secret、完整规则配置、员工票据或向量内容。

### Go 票据复核队列验收

`000012_receipt_review_queue.sql` 是 Go `reimbursement` schema 的前向迁移。它会规范化历史票据问题、为既有 `REVIEW_REQUIRED` 票据回填可领取案件，并保证每张票据至多一个 `OPEN` 或 `CLAIMED` 案件。执行前按既有 PostgreSQL 备份流程备份目标库；不要通过清空 `review_cases`、删除票据或重建数据卷来重新开始。

本地 Compose 环境由受控 DDL 账号执行：

```powershell
Get-Content -Raw services/reimbursement-api/db/migrations/000012_receipt_review_queue.sql |
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reimbursement -d reimbursement

docker compose --profile migration up -d --build reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
docker compose --profile migration ps
```

验收时使用测试员工和非敏感样票：制造一张置信度低于 `0.70`、内容重复或已提交发票号重复的票据；以 `FINANCE_REVIEWER` 或 `ADMIN` 登录 `/admin/reviews`，领取案件后选择确认、更正字段、要求重新上传或关闭无效票据。确认案件版本递增、`review_case_audits` 有对应动作，且员工报销工作台只显示票据安全状态，不显示原因码、复核人和处理说明。使用普通员工访问任意 `/api/v1/admin/reviews` 路径必须返回 `403`，且响应不包含案件 ID 或票据字段。

本地测试专用的 `REIMBURSEMENT_ALLOW_DUPLICATE_*_FOR_TESTING` 开关只能用于开发环境，不能带入生产配置；它用于降低有限样票的重复校验阻塞，不改变复核队列的数据安全和审计规则。

## 日志平台与失败告警

日志平台由 Loki、Grafana、Alloy、Alertmanager 与 `alert-relay` 组成，使用 Docker 内网通信；Grafana、Loki、Alertmanager 与 Relay 均不得暴露主机端口。仅通过受控反向代理、企业 VPN 或临时的运维端口转发访问 Grafana，禁止把 Loki API 或 Grafana 管理端口直接发布到互联网。

实际告警发送前，创建一个专用告警群并为该群添加飞书群机器人。将机器人的 Webhook 地址仅写入未提交的 `.env.local` 或生产 Secret：

```dotenv
FEISHU_ALERT_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/..."
```

不要在聊天、工单、代码、日志或截图中粘贴该地址；它相当于向该群发送消息的凭据。缺少或格式错误时 `alert-relay` 会启动失败，普通 Web 与业务 Worker 不受影响。

启动或更新平台：

```powershell
docker compose --profile observability up -d --build
docker compose --profile observability ps
docker compose --profile observability logs --tail=200 alloy loki grafana alertmanager alert-relay
docker compose exec -T loki wget -qO- http://localhost:3100/prometheus/api/v1/rules
docker compose run --rm --no-deps --entrypoint amtool alertmanager check-config /etc/alertmanager/alertmanager.yml
```

首次部署前，在未提交的 `.env.local` 或生产 Secret 中设置 `GRAFANA_ADMIN_USER` 与高强度的 `GRAFANA_ADMIN_PASSWORD`。Grafana 默认禁用匿名访问和用户自行注册。平台日志由 Docker volume 保存 30 天；这一留存不会删除 PostgreSQL 中的 `AuditEvent`、`AsyncJob` 或 `ReviewCase` 业务事实。

Grafana Explore 选择 `Loki` 数据源，以 `{service="job-worker"} | json | jobId="<任务 ID>"` 查询任务链路，或按响应头 `x-request-id` 查询 Web 请求。`jobId`、`claimId`、`receiptId` 仅在 JSON 正文中解析，绝不能提升为 Loki 标签。Loki 标签只允许 `service`、`environment`、`level`、`event` 和 `jobKind`。

内置告警覆盖：任务 Worker 五分钟无心跳、票据任务领取前等待超过十五分钟、OCR 十分钟失败率超过 20%（最少十个样本）、三十分钟新增人工复核超过 20 个、以及 Loki/Alloy 采集错误。规则由 Loki Ruler 计算，Alertmanager 负责聚合、抑制和重试，`alert-relay` 负责发送飞书卡片。Webhook 仅发送规则名、严重级别、服务、摘要和安全时间信息，不能发送票据、会话内容、对象键或凭据。

验收时仅在测试环境创建一条含固定 `summary` 的无害测试规则，等待 30 秒分组窗口后确认专用告警群收到卡片；将规则恢复为正常状态后，确认收到“已恢复”卡片。不要通过停止生产 Worker、上传异常票据或直接制造业务失败来触发演练。飞书投递失败时，查看 `docker compose logs --tail=200 alertmanager alert-relay`，由 Alertmanager 重试；不要通过重启业务服务、清空 `loki-data` 或重新生成 Webhook 来处理单次投递失败。

当前没有固定域名和受控的 Grafana 外部入口，飞书告警卡片不会附带外部仪表盘链接。固定域名、反向代理和 Grafana SSO 就绪后，再单独评审并加入只读运维链接。

排障顺序：先确认 `alloy`、`loki`、`grafana`、`alertmanager` 与 `alert-relay` 都运行，再检查 Alloy 是否能访问只读 Docker Socket、Loki 是否可接收日志、Alertmanager 是否加载路由、Relay 是否健康，以及 Grafana 是否已加载 `Loki` 数据源和“任务运行总览”仪表盘。不要通过清理 `loki-data` 来处理单一应用异常；它仅用于保留期或容量治理，业务审计以 PostgreSQL 为准。

若要回滚通知能力，停止并移除 `alertmanager` 与 `alert-relay` 服务即可；Loki 仍会计算规则但不会投递外部消息。不得删除 Loki 数据卷、业务数据库或既有告警规则。

规则加载和评估应以 `http://localhost:3100/prometheus/api/v1/rules` 的容器内响应为准：每条规则应为 `health: "ok"` 且 `lastError` 为空。不要只依赖 `docker compose logs --tail=100 loki`，因为规则加载日志只在 Loki 启动阶段输出，后续会被周期评估日志覆盖。

## 政策知识库运行

先备份 PostgreSQL，再部署 pgvector 迁移；不得重建 `postgres-data` 卷。Embedding 服务使用 `knowledge` Compose profile 和 `embedding-models` 缓存卷，生产环境仅通过 Docker 内网访问，不得发布主机端口。开发机以宿主机运行 Web 时，可叠加 `docker-compose.local.yml`，将端口仅绑定到 `127.0.0.1:8081`，并使用 CPU PyTorch；该覆盖文件不得用于生产。首次同步会下载 BGE-M3 模型；生产 GPU 可使用独立构建的 GPU 镜像及 `docker-compose.gpu.yml`。来源同步失败时保留最近活动快照，排查时只记录来源 ID 与安全错误分类，不记录文档正文、token 或向量。

## 飞书机器人运行

启动前执行 `npm run feishu:worker` 所需的环境校验：`FEISHU_BOT_ENABLED=true`、飞书 App 凭据、机器人 `open_id`、`APP_PUBLIC_URL`、数据库、MinIO、ClamAV 和 OCR 地址均必须完整。生产环境的 `APP_PUBLIC_URL` 必须为 HTTPS。

长连接回调仅持久化事件 ID、消息 ID、会话 ID、发送者 `open_id` 和状态，不记录原始飞书事件包、附件字节、对象键或 access token。规范化的用户文本与助手安全回复保存在员工会话中，用于跨 Web/飞书私有历史回放；会话不是草稿事实来源，金额、票据、版本与提交状态始终从 Intake/ClaimDraft 重新读取。Worker 会领取 `PENDING` 与安全可重试事件；已完成业务即使飞书回复失败也不会回滚草稿、附件或已保存会话消息。

容器部署：

```powershell
docker compose --env-file .env.local --profile migration up -d --build feishu-bot-worker agent-event-worker reimbursement-api reimbursement-worker reimbursement-web reimbursement-edge
docker compose logs -f feishu-bot-worker
docker compose restart feishu-bot-worker
```

Worker 重启后会恢复未领取或可安全重试的事件。若 OCR、病毒扫描或对象存储不可用，先恢复相应依赖，再在 Web 工作台确认草稿和附件状态；不要通过删除数据库事件来“重试”。

### OCR 结果主动通知

Go 工具网关硬切换后，新的飞书票据上传由 `reimbursement-worker` 完成 OCR，并由 `agent-event-worker` 消费 Go 领域事件投递识别结果。以下 `ReceiptExtractionNotification` 步骤仅用于排查切换前遗留的 Next.js 异步任务记录，不能作为新 Agent 票据链路的验收依据。

飞书附件上传会创建 `ReceiptExtractionNotification` Outbox；它与 OCR `AsyncJob` 一一对应，仅保存原会话 `chatId`、关联 ID 和安全状态，不保存附件字节、对象键或飞书凭据。附件接收与识别结果分别是两条飞书消息：第二条由 `feishu-bot-worker` 在 OCR 任务进入 `SUCCEEDED`、`REVIEW_REQUIRED` 或 `CLOSED` 后投递。

通知状态：`PENDING` 等待 OCR 结束，`PROCESSING` 已被机器人 Worker 领取，`RETRY_WAIT` 等待 1/5/30 分钟退避，`SENT` 已发送，`CLOSED` 因不可恢复的飞书投递错误或达到重试上限而停止。发送使用通知 ID 作为飞书消息 UUID；不要通过删除记录来重发。

排障时先确认两个 Worker 都正常运行，再只读查询状态：

```powershell
docker compose ps
docker compose logs --tail=200 job-worker
docker compose logs --tail=200 feishu-bot-worker
docker compose exec -T postgres psql -U reimbursement -d reimbursement -c 'SELECT "status", "attemptCount", "failureCode", "createdAt" FROM "ReceiptExtractionNotification" ORDER BY "createdAt" DESC LIMIT 20;'
```

验收：在已绑定的飞书账号单聊机器人上传一张完整票据，应先收到“正在识别”、后收到字段摘要；上传字段不完整的票据，应收到待确认字段和人工复核提示；从 Web 工作台上传同类文件不应新增通知记录或发送飞书消息。飞书机器人必须拥有发送消息权限，并保持 `APP_PUBLIC_URL` 为员工可访问的 HTTPS 地址。

### 飞书会话留存与回滚

`AgentConversation`、`AgentMessage` 和 `ReimbursementIntake` 是飞书 Agent 会话与办理状态。部署相关 Prisma 迁移前先备份 PostgreSQL，再执行 `npx prisma migrate deploy --config prisma7.config.ts`，并更新 `feishu-bot-worker`。React 工作台没有 Agent 对话入口。群聊按员工和群聊 ID 隔离，排障时不得把群聊消息导出到私有会话或日志。

会话、消息和 Intake 随员工删除级联清理；删除草稿只会将关联 Intake 的草稿引用置空，不删除会话历史。不要通过清空会话表来处理单一失败：对于 OCR/模型/回复失败，保留已保存消息和 Intake，以服务端安全错误分类提示重试或回到 Web。需要缩短留存期时，应先制定员工、审计和政策依据的保留策略并经数据负责人审批，再执行可验证的分批清理。

应用回滚只能回滚应用镜像；已经执行的会话迁移保持在数据库中，不回退或手改 Prisma 迁移记录。若必须回滚会话契约，应先停止飞书 Worker，检查待处理事件，再恢复兼容版本的长连接。

发布前在测试企业逐项核对：发布应用版本；单聊文本；群聊仅 `@机器人`；JPG/PNG/PDF；未绑定用户；相同消息重投；Worker 重启；飞书下载、OCR、模型和回复失败；以及本人单据查询、建议确认和提交权限。自动化测试只使用伪造飞书消息和附件，不使用真实 App Secret 或真实发票。
