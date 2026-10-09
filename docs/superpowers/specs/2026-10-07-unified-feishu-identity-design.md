# 统一飞书身份链路设计

## 背景与决策

当前个人开发环境没有可用的企业 SSO，但已有飞书个人账号 OAuth 登录。React Web、Go 报销 API 与飞书 Agent 已分属不同运行单元：现有 Next.js 使用签名 Cookie 会话，Go API 校验 HS256 Bearer Token，Agent 使用服务密钥和受委托 Token；React 仅有开发环境 Token 桥接。因此，同一飞书用户尚未在三个入口上形成可验证的一致身份边界。

本设计采用**方案 1：复用现有 Next.js/Agent 运行时作为轻量 Auth BFF**。它继续处理飞书 OAuth 与浏览器会话，并签发短期应用 JWT 给 React；Go API 验证 JWT；Agent 使用同一签发规则、但带独立的 `channel=agent` 与服务密钥。此设计不引入独立 Auth Service，也不依赖企业 SSO；未来可在不改变报销业务 API 的前提下替换身份提供方。

## 目标

1. 使用飞书 app-scoped `open_id` 将 Web OAuth、飞书机器人事件与内部 `employee_id` 唯一对应。
2. 让 React 调用 Go API 时使用由 Auth BFF 签发、Go 可验证的短期 JWT；Go 不再相信浏览器传入的员工 ID。
3. 保留 Agent 的受委托调用模式，同时确保 Web Token 与 Agent Token 不能互相替代。
4. 在没有企业组织目录时，以环境变量 `open_id` 白名单授予 `ADMIN` 与 `FINANCE_REVIEWER`，未命中者为 `EMPLOYEE`。
5. 在 Web OAuth 与飞书机器人两个首次入口，都确保同一个 `employee_id` 已同步到 Go 报销域。

## 非目标

- 本期不接入企业 SSO、SCIM、LDAP 或飞书组织架构同步。
- 本期不新建独立认证服务，不将飞书授权 Token 下发给浏览器，也不在浏览器持久化应用 JWT。
- 本期不提供角色后台管理；角色仍由环境变量白名单控制。
- 本期不迁移或删除已有报销测试数据；新系统按空数据环境验证。
- 本期不改变飞书 OAuth 的应用凭据、回调域名或授权范围之外的开放平台能力。

## 服务边界与部署路由

生产形态使用单一公网域名，并由反向代理按路径分流：

```text
https://reimbursement.example.com/
  /                  -> React 静态站点
  /api/auth/*        -> Next.js Auth BFF
  /api/v1/*          -> Go reimbursement-api
  /internal/*        -> 不经公网代理，仅容器私网可访问
```

同源部署让浏览器只携带 Auth BFF 的 HttpOnly Cookie 到 `/api/auth/*`，React 不需要处理跨域 Cookie 或生产 CORS。开发环境可通过 Vite 开发代理将同样的路径分别转发到本地 Auth BFF 与 Go API。

## 身份与员工模型

系统已有两个员工投影：

| 存储 | 职责 | 关键字段 |
|---|---|---|
| Prisma `Employee` | 飞书身份绑定、Agent 会话归属 | `id`、`feishuUserId`、`displayName` |
| `reimbursement.employees` | Go 报销资源归属、角色、启用状态 | `id`、`feishu_user_id`、`display_name`、`role`、`is_active` |

不创建第三份身份表。Auth BFF/Agent 以 Prisma `Employee` 维护 `open_id -> employee_id` 绑定；Go 保存相同 `employee_id` 的报销域投影。所有新身份都走一个 `ensureEmployeeIdentity` 应用服务：

1. 用 `open_id` 查找 Prisma `Employee`；不存在时创建最小员工记录。
2. 从环境变量计算其角色。
3. 通过 Go 内部员工同步接口，按相同 `employee_id` 幂等创建或更新 `reimbursement.employees`。
4. 同步成功后，OAuth 才签发 Web JWT；Agent 才调用受委托报销工具。

飞书机器人首次遇到未知 `open_id` 时也调用上述流程，以便用户可以先在飞书创建报销草稿、之后再打开 Web 工作台。显示名缺失时使用安全默认值“飞书员工”。

## 临时角色模型

新增配置：

```env
FEISHU_ADMIN_OPEN_IDS=
FEISHU_FINANCE_REVIEWER_OPEN_IDS=
REIMBURSEMENT_AUTH_PROVISIONING_KEY=
```

规则：

- `FEISHU_ADMIN_OPEN_IDS` 命中时角色为 `ADMIN`；`FEISHU_FINANCE_REVIEWER_OPEN_IDS` 命中时为 `FINANCE_REVIEWER`；否则为 `EMPLOYEE`。
- 任意非空 `open_id` 同时出现在两份列表中，进程启动失败，防止歧义。
- 白名单变更后，用户的下一次 Web 登录、Token 刷新或 Agent 操作重新计算角色并更新 Go 投影。
- `reimbursement.employees.is_active=false` 时，Go API 拒绝该员工的一切报销写操作；Agent 不替其创建或提交单据。
- Go API 的入口鉴权使用带签名的 JWT 角色；政策发布、复核结案等高权限操作还必须比对 `reimbursement.employees.role`，避免角色投影不同步造成越权。

角色后台管理是后续扩展：届时数据库角色规则取代白名单，但保持 `resolveRole(openID)` 与员工同步接口的外部合同不变。

## 浏览器会话与 Token

现有飞书 OAuth 路由保留在 Auth BFF：

```text
GET  /api/auth/feishu/login?returnTo=/claims
GET  /api/auth/feishu/callback
GET  /api/auth/access-token
POST /api/auth/logout
```

OAuth 成功后，Auth BFF 继续写入 HttpOnly、SameSite=Lax 的 `reimbursement_session` Cookie。飞书 `access_token`、client secret 与授权码不进入 URL、浏览器状态、应用数据库、审计载荷或日志。

`returnTo` 只接受单个 `/` 开头、且不以 `//` 开头的站内相对路径；不合规时使用默认工作台路径。回调将用户带回 `returnTo`，而不是固定跳转旧 Next.js 页面。

React 启动和刷新时调用 `GET /api/auth/access-token`。若 Cookie 有效且员工同步完成，响应为：

```json
{
  "accessToken": "eyJ...",
  "expiresAt": "2026-10-07T12:00:00Z",
  "employee": {
    "id": "emp_xxx",
    "displayName": "陈亦博",
    "role": "EMPLOYEE"
  }
}
```

React 只在内存中保存 Token，并在距离过期一分钟时刷新。调用 Go API 获得一次 `401` 时，前端刷新 Token 后使用**相同的 `Idempotency-Key`**重试一次；第二次失败才显示登录或错误状态。写请求不得因自动重试生成新的幂等键。登出同时清除 Cookie、内存 Token 和前端用户状态。

本期 JWT 是使用 `REIMBURSEMENT_AUTH_HS256_SECRET` 签发的 HS256 JWT，TTL 固定为 15 分钟：

```json
{
  "sub": "employee_id",
  "role": "EMPLOYEE | FINANCE_REVIEWER | ADMIN",
  "aud": "reimbursement-api",
  "channel": "web | agent",
  "jti": "随机唯一 ID",
  "iat": 0,
  "exp": 0
}
```

`REIMBURSEMENT_AUTH_HS256_SECRET` 是 Auth BFF、Agent 与 Go API 的专用签名密钥，必须与 `SESSION_SECRET` 分离。移除 Go 容器以 `SESSION_SECRET` 自动兜底该密钥的逻辑。开发演示登录可以保留，但也必须经 Auth BFF 签发相同 JWT；不再以 `VITE_REIMBURSEMENT_DEV_TOKEN` 构成生产调用链路。

## Go API 鉴权与内部员工同步

Go API 的 Web Bearer Resolver 只接受签名正确、未过期、`aud=reimbursement-api`、`channel=web` 且 `sub` 非空的 Token。资源所有权始终从 `sub` 获取；请求体、URL 参数或前端状态中的员工 ID 不可作为授权依据。

Agent Resolver 在上述基础上要求 `channel=agent`、非空 `jti`、活动员工状态和正确的 `X-Agent-Service-Key`。Web Token 缺少该服务密钥且 `channel` 不匹配，不能冒充 Agent；反过来也成立。

新增仅限私网调用的接口：

```text
PUT /internal/v1/employees/{employeeId}
```

它只接受 `X-Auth-Provisioning-Key`，不能使用 `X-Agent-Service-Key`，也不由公网反向代理发布。请求携带显示名、飞书 `open_id`、角色与活动状态；服务按 `employee_id` 幂等 Upsert `reimbursement.employees`。

若 OAuth 回调或 Token 刷新期间员工同步失败，Auth BFF 返回可重试的 `503 IDENTITY_PROVISIONING_UNAVAILABLE`，不签发 JWT。若 Agent 同步失败，机器人不创建或提交报销单，并回复通用重试提示；日志只记录脱敏错误码、员工 ID 与 request ID。

## Agent 身份流

```text
飞书事件 sender.open_id
  -> ensureEmployeeIdentity
  -> Prisma Employee / Go employee projection
  -> 生成 channel=agent 的 15 分钟委托 JWT
  -> X-Agent-Service-Key + Authorization: Bearer <JWT>
  -> Go Reimbursement API
```

Agent 不可从消息内容读取或指定 `employee_id`。它以事件发送方绑定的身份创建草稿、上传附件、补充字段、校验和提交；审计继续记录员工、渠道、会话与工具调用 ID。

## 错误、安全与日志规则

- OAuth state 缺失或不一致、授权码交换失败、飞书身份没有 `open_id`：不创建会话、不签发 JWT。
- 身份同步失败：保留可安全重试的本地身份绑定，但不赋予报销 API 访问能力。
- JWT 的签名、`sub`、`aud`、`channel`、`jti`、过期时间任一不符合合同：Go 返回 `401 UNAUTHENTICATED`。
- Token 或 Cookie 不写入客户端持久化存储、URL、审计字段或结构化日志。
- `open_id` 只存在于授权映射表与受控服务日志的必要字段；对外错误、Agent 回话和业务审计不回显它。
- Auth BFF、Agent、Go API 为同一请求关联 `request_id`；Agent 工具链附加 `conversation_id` 与 `tool_call_id`。

## 验收标准

1. 首次 Web 飞书 OAuth 登录创建或复用正确的 `employee_id`，并在 Go 侧生成同 ID 员工投影。
2. 首次向飞书机器人发消息的用户，无需先访问 Web，也能创建最小身份和报销草稿；随后 Web 登录绑定至同一员工。
3. React 刷新页面可由 HttpOnly Cookie 重新获得 JWT；浏览器持久化存储与 URL 中没有 Token。
4. 同一 Web 写请求在因过期 Token 自动刷新后只重试一次，并复用原 `Idempotency-Key`。
5. 修改 JWT 的 `sub`、`role`、`aud`、`channel`、过期时间或签名，Go API 均拒绝。
6. Web JWT 不能作为 Agent Token；Agent Token 不能作为 Web Token；Agent 服务密钥不能调用内部员工同步接口。
7. 白名单可正确授予角色，名单交叉导致启动失败；白名单调整后下次身份解析更新 Go 员工投影。
8. 停用员工不能经 Web 或 Agent 创建、修改或提交报销单。
9. 内部员工同步接口不由生产反向代理暴露，且未提供正确 Provisioning Key 时拒绝访问。

## 主要风险与控制

| 风险 | 控制 |
|---|---|
| 浏览器 Token 泄露 | Token 仅内存保存、15 分钟 TTL、飞书 Token 永不下发 |
| Web/Agent 身份不一致 | 两入口共享 `ensureEmployeeIdentity` 和相同 `open_id -> employee_id` 绑定 |
| 角色白名单配置错误 | 启动期交叉校验、确定的优先级、下次解析时重新同步 |
| Go 侧员工不存在导致外键失败 | 在签发/工具调用前经独立私网接口幂等同步 |
| 内部接口被误暴露 | 专用路径、反向代理显式拒绝、独立 Provisioning Key |
| Token 过期造成重复提交 | 自动重试保留原 Idempotency-Key，并限制为一次 |

