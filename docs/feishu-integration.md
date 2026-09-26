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
3. 在「事件与回调」选择**长连接**，订阅 `im.message.receive_v1`。此模式不填写回调 URL、验证 Token 或加密 Key。
4. 在「版本管理与发布」发布到测试企业；将机器人加入测试单聊或群聊。

群聊仅响应明确 `@机器人` 的消息；不要开通 `im:message.group_msg`。机器人只会发送登录链接、进度和 Web 工作台链接，不会在飞书内确认建议、删除票据或提交报销单。

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
- 已绑定账号：单聊文字、群聊 `@机器人`、JPG/PNG/PDF 均可创建或续办当前草稿。
- 群聊未 `@机器人`：不回复、不创建草稿。
- `新建报销` 替换当前会话草稿；`查看当前草稿` 返回工作台链接。
- 重复发送同一消息、Worker 重启、飞书下载失败、OCR/模型失败：不得创建重复草稿或重复票据。
- Web 工作台仍是唯一的建议确认、删除和提交入口。
