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

仅格式正确的 `ou_...` 飞书 `open_id` 会被接受。空白、重复或无效值不会授予权限；白名单为空时是安全的只读状态，不会影响员工报销草稿和基础校验。

发布前由管理员在 `/admin/policies` 核对草稿规则、规则级别和生效日期。`BLOCKING` 会阻止确认与提交，`WARNING` 仅提示但会留在确认摘要和提交快照中。发布后不能直接修改版本；若需要撤回或修正制度，创建一份新的草稿并发布。这样会归档旧的已发布版本，但不会改写已提交报销单中的政策快照。

应用回滚只回滚应用镜像或执行经验证的数据库恢复流程；不要删除迁移记录、政策审计或提交快照。若新版本政策不应继续生效，优先发布一份经核对的替代版本；在没有有效发布版本时，系统仍保留基础校验，不会把员工提交视作已符合政策。

本地开发使用 `MODEL_PROVIDER="fixture"`。生产必须设置 `MODEL_PROVIDER="openai-compatible"`、`MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_PROVIDER_API_KEY` 和可选 `MODEL_TIMEOUT_MS`。

模型异常时，聊天接口返回可恢复错误，员工仍可通过工作台字段编辑继续处理。暂停真实模型时，将 `MODEL_PROVIDER` 切换为本地 Fixture 并重启服务；不要删除既有建议或审计记录。

重点监控：OCR 失败率、上传安全扫描失败、模型 `TIMEOUT`/`UNAVAILABLE`、`MODEL_RESPONSE_REJECTED`、建议确认版本冲突和提交前阻断项数量。日志不得记录 API Key、对象键、原始票据内容或完整提示词。

政策监控另包括：管理员 `403` 比例、草稿保存/发布版本冲突、发布审计事件、政策阻断与预警数量、以及无有效发布政策的持续时长。日志不得记录飞书 App Secret、完整规则配置、员工票据或向量内容。

## 政策知识库运行

先备份 PostgreSQL，再部署 pgvector 迁移；不得重建 `postgres-data` 卷。Embedding 服务使用 `knowledge` Compose profile 和 `embedding-models` 缓存卷，且不得发布主机端口。首次同步会下载 BGE-M3 模型；GPU 可使用 `docker-compose.gpu.yml`，CPU 部署不需要业务代码变更。来源同步失败时保留最近活动快照，排查时只记录来源 ID 与安全错误分类，不记录文档正文、token 或向量。

## 飞书机器人运行

启动前执行 `npm run feishu:worker` 所需的环境校验：`FEISHU_BOT_ENABLED=true`、飞书 App 凭据、机器人 `open_id`、`APP_PUBLIC_URL`、数据库、MinIO、ClamAV 和 OCR 地址均必须完整。生产环境的 `APP_PUBLIC_URL` 必须为 HTTPS。

长连接回调仅持久化事件 ID、消息 ID、会话 ID、发送者 `open_id` 和状态，不记录正文、附件字节、对象键或 access token。Worker 会领取 `PENDING` 与安全可重试事件；已完成业务即使飞书回复失败也不会回滚草稿或附件。

容器部署：

```powershell
docker compose up -d --build web feishu-bot-worker
docker compose logs -f feishu-bot-worker
docker compose restart feishu-bot-worker
```

Worker 重启后会恢复未领取或可安全重试的事件。若 OCR、病毒扫描或对象存储不可用，先恢复相应依赖，再在 Web 工作台确认草稿和附件状态；不要通过删除数据库事件来“重试”。

发布前在测试企业逐项核对：发布应用版本；单聊文本；群聊仅 `@机器人`；JPG/PNG/PDF；未绑定 OAuth 用户；相同消息重投；Worker 重启；飞书下载、OCR、模型和回复失败；以及 Web 仍是建议确认、删除和提交的唯一入口。自动化测试只使用伪造飞书消息和附件，不使用真实 App Secret 或真实发票。
