# 飞书 OAuth 与开发演示登录设计

## 目标

为独立报销 Web 提供可用的员工身份入口：开发阶段可用个人飞书账号完成 OAuth 登录；未配置飞书凭据时仅在非生产环境提供受限的本地演示登录。所有既有报销与 Agent API 继续只信任服务端签发的签名会话 Cookie。

## 身份模型

OAuth 回调由服务端用授权码换取飞书用户身份。优先保存并使用 app-scoped `open_id`，同时保留可选的 `union_id` 以便同一开发者后续关联多个应用。系统以 `Employee.feishuUserId` 映射本地员工；首次登录时创建最小员工记录，显示名使用飞书返回值或安全的默认名。

本地演示登录不接受任意员工 ID：它只允许 `.env.local` 中配置的单个 `DEV_DEMO_EMPLOYEE_ID`，并只在 `NODE_ENV !== "production"` 时可访问。生产缺少飞书配置时登录失败，不降级。

## 路由与状态

- `GET /api/auth/feishu/login`：生成并写入短时、HttpOnly、SameSite=Lax 的 OAuth state Cookie，并重定向至飞书授权页。
- `GET /api/auth/feishu/callback`：验证 state，交换 code，读取用户身份，映射员工，签发现有报销会话 Cookie，再跳转至 `/claims/new`。
- `POST /api/auth/dev-login`：仅开发环境签发受限演示员工会话。
- `POST /api/auth/logout`：删除会话与 OAuth state Cookie。

会话由服务端 HMAC 签发，Cookie 为 HttpOnly、SameSite=Lax；生产环境必须使用 Secure。授权码、client secret、access token 不写入 URL、前端状态、审计 payload 或日志。

## 配置

```
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_REDIRECT_URI=http://localhost:3000/api/auth/feishu/callback
DEV_DEMO_EMPLOYEE_ID=demo-employee
DEV_DEMO_EMPLOYEE_NAME=演示员工
```

飞书开放平台中需创建应用、配置上述回调地址，并按当前飞书 OAuth 文档启用所需的用户身份授权范围。具体 endpoint 和返回字段集中在 `src/infrastructure/auth/feishu-oauth.ts`，便于平台 API 变化时维护。

## 失败处理与验收

state 缺失、state 不匹配、授权码交换失败、身份响应不完整均不签发会话，返回可操作的中文错误。登录成功后只有本人数据可见；生产路由不暴露本地演示登录。

测试覆盖：state 校验、生产禁用演示登录、`open_id` 员工映射、会话 Cookie 的安全属性，以及回调失败不创建会话。
