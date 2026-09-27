# 飞书机器人集成

## 开放平台配置

1. 在「添加应用能力」启用**机器人**。
2. 在「权限管理」以应用身份开通：
   - `im:message`
   - `im:message.group_at_msg:readonly`
   - `im:message.p2p_msg:readonly`
   - `im:message:send_as_bot`
   - `im:resource`
   - `contact:user.base:readonly`（Web OAuth 继续使用）
   - `docx:document:readonly`（同步已授权的飞书文档）
   - `wiki:wiki:readonly`（解析并读取已授权的飞书知识库页面）
3. 在「事件与回调」选择**长连接**，订阅 `im.message.receive_v1`。此模式不填写回调 URL、验证 Token 或加密 Key。
4. 在「版本管理与发布」发布到测试企业；将机器人加入测试单聊或群聊。

群聊仅响应明确 `@机器人` 的消息；不要开通 `im:message.group_msg`。单聊消息进入员工的 Web 私有会话，群聊消息按“员工 + 群聊”隔离，群聊内容不会出现在 Web 私有历史。机器人可回答带依据的政策问题、创建受控办理状态和上传票据；删除草稿/票据仍在 Web 工作台完成。只有当前办理已进入等待确认状态时，精确发送 `确认提交` 才会调用服务端复核和提交。

机器人也不具备创建、编辑或发布报销政策的权限。即使消息中包含制度文本或“发布规则”指令，也只能引导员工或管理员回到 Web；可执行政策仍由 `/admin/policies` 的白名单管理员通过服务端会话发布。

政策知识库也不会遍历飞书空间：管理员只能在 Web 中逐条录入已授权的 Docx 或 Wiki URL。应用需同时被授予该文档或知识库的阅读权限；Wiki 场景还需由知识库管理员按飞书的访问机制授予应用可读范围。同步失败不会覆盖已生效的政策快照。

## Worker 配置与运行

Worker 与 Web 复用相同的数据库、MinIO、ClamAV、OCR 和模型配置。将凭据只放在未提交的 `.env.local`：

```dotenv
FEISHU_APP_ID="cli_..."
FEISHU_APP_SECRET="..."
FEISHU_BOT_ENABLED="true"
FEISHU_BOT_OPEN_ID="ou_..."
FEISHU_EVENT_DELIVERY="long_connection"
APP_PUBLIC_URL="https://reimbursement.example.com"
```

本机可执行 `npm run feishu:worker` 来建立长连接。不要在 Next.js Route Handler、浏览器或无状态函数中启动它。生产以 `feishu-bot-worker` 容器常驻运行；Worker 只需向飞书出网，员工浏览器需要访问 `APP_PUBLIC_URL`。

## 测试企业检查清单

- 未绑定 Web OAuth 的账号：只收到登录链接，不创建员工、草稿或附件。
- 已绑定账号：单聊文字与 Web 悬浮入口共享私有历史；群聊 `@机器人` 独立；政策问答不创建草稿；`开始报销` 或 JPG/PNG/PDF 才创建或续办 Intake。
- 群聊未 `@机器人`：不回复、不创建草稿。
- `新建报销` 等同于“开始报销”，不会在没有票据时立即创建草稿；只有 `READY_TO_SUBMIT` 后的精确 `确认提交` 可提交。
- 重复发送同一消息、Worker 重启、飞书下载失败、OCR/模型失败：不得创建重复消息、草稿、票据或重复提交。
- Web 工作台提供历史回放和删除操作；飞书群聊历史不得在 Web 私有会话中出现。
