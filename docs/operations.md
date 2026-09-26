# 运维说明

数据库结构升级：

```powershell
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
```

本地开发使用 `MODEL_PROVIDER="fixture"`。生产必须设置 `MODEL_PROVIDER="openai-compatible"`、`MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_PROVIDER_API_KEY` 和可选 `MODEL_TIMEOUT_MS`。

模型异常时，聊天接口返回可恢复错误，员工仍可通过工作台字段编辑继续处理。暂停真实模型时，将 `MODEL_PROVIDER` 切换为本地 Fixture 并重启服务；不要删除既有建议或审计记录。

重点监控：OCR 失败率、上传安全扫描失败、模型 `TIMEOUT`/`UNAVAILABLE`、`MODEL_RESPONSE_REJECTED`、建议确认版本冲突和提交前阻断项数量。日志不得记录 API Key、对象键、原始票据内容或完整提示词。

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
