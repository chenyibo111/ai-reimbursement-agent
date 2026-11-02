# React 报销工作台接入本地 SSO 设计

## 目标与范围

让迁移 Profile 中的 React 工作台（`apps/web`）通过 `D:\AI\feishu-sso` 登录，并让 Go 报销 API 在统一退出后立即拒绝该会话的 Web JWT。Next.js 继续作为 React 的认证 BFF，提供 `/api/auth/`；现有 Next.js 页面、直连飞书 Web 登录及飞书机器人保持原有行为。本轮不切换真实员工流量，也不改飞书机器人身份。

用户允许 SSO 登录创建新的本地员工账号。旧员工及报销单不删除、不迁移；两个仓库配置了不同的飞书应用，同一成员在两个应用中的 `open_id` 不同，所以新旧员工及机器人身份不会自动合并。React 和机器人目前可能显示不同的本人数据，待后续专门做跨应用账号关联。

## OIDC 与员工身份

- React 的登录入口改为 SSO OIDC；BFF 执行授权码 + PKCE，校验 `state`、`nonce`、ID Token 签名、发行者、受众、有效期、`sid` 与自定义身份声明。浏览器不持久化 OIDC 令牌。
- 新增独立 Hydra 客户端 `reimbursement-web`，精确登记 `http://localhost:8088/api/auth/sso/callback`、`http://localhost:8088/logged-out` 和 Hydra 容器可达的后端退出地址。只允许授权码流，范围为 `openid profile feishu_identity`。
- SSO 在其 PostgreSQL 中保存经飞书验证的 `sub`、`open_id`、显示名和租户标识映射。登录时先写入映射，再接受 Hydra 登录；再次授权时，consent 能按 `sub` 找回身份。仅获准 `feishu_identity` 范围的客户端在 ID Token 中收到 `feishu_open_id` 声明。SSO 未找到身份、数据库故障或租户不匹配时拒绝该声明。
- BFF 用已验证的 `feishu_open_id` 调用现有 `ensureFeishuIdentity`，创建新员工并同步 Go 员工投影。角色名单需要使用 SSO 飞书应用下新的 `open_id`；默认角色仍为普通员工。既有 Next.js 飞书登录和开发演示登录不作为 React 的回退入口。

## 会话与统一退出

- BFF 为 React 使用独立、随机的 HttpOnly 项目会话 Cookie；服务器在报销数据库中保存员工 ID、Hydra `sid`、验证过的 ID Token 和有效期。React 的 `/api/auth/access-token` 只接受此会话，向 SSO `/session-status` 查询撤销状态后才签发 15 分钟的报销 Web JWT；失败时不签发。
- Web JWT 增加 `sid`。Go API 的 Web 身份解析器在验证本地 JWT 后，以受限的服务凭据向 SSO 查询该 `sid` 是否撤销；SSO 不可用时拒绝 Web 请求。Agent Token 仍按原有 `channel=agent` 路径验证，不受本轮 Web 会话规则影响。无 `sid` 的旧 Web JWT 不被 React 迁移 Profile 接受。
- React 的退出入口由浏览器导航到 BFF，再按 Hydra 的 RP 发起退出流程跳转，携带 `id_token_hint` 和登记的退出后地址。SSO 先持久撤销 `sid`，再接受 Hydra 退出。React 的 `/logged-out` 页面显示退出结果，不立即重新登录。
- BFF 接收 Hydra 的后端退出通知，验证签名、发行者、受众、事件、时间和 `sid`，删除匹配的本地会话。Hydra 通知异步发送，Go API 与 BFF 对中心撤销状态的检查承担即时拒绝访问的保证。
- 旧 Next.js 页面的直连飞书会话和飞书机器人会话不在本轮跨项目退出范围；React、演示项目 A/B 和 Hydra SSO 会话必须联动。

## 本地端口与服务连接

- 保留 SSO 的飞书回调 `localhost:9000`、Hydra `localhost:4444/4445`、PostgreSQL `localhost:5433`，避免改动已验证的飞书后台配置。
- 报销项目 Compose 将 PostgreSQL 与 MinIO 的宿主机端口配置化；与 SSO 同时运行时分别改为未占用端口，建议 `15433` 和 `19000`。容器内数据库、MinIO 端口不变。报销项目本机数据库 URL、S3 公开地址随之调整；真实凭据留在未提交的 `.env.local`。
- React、BFF 和 Go API 通过现有边缘代理 `localhost:8088` 对外。BFF/Go 容器通过 `host.docker.internal` 访问本机 SSO/Hydra；OIDC 验证仍使用 Hydra 宣告的 `http://localhost:4444/` 发行者，不因内部连接地址改变信任目标。后端退出地址通过边缘代理从 Hydra 容器可达。
- 仅 Go API 使用新的 SSO 服务凭据查询 `sid` 撤销状态；该接口不接受匿名 `sid` 查询，不在公开日志中记录令牌或密钥。

## 验收

1. SSO 仅为正确授权范围签发有效 `feishu_open_id`；其他客户端令牌不含该字段。未知 `sub`、数据库故障和租户不匹配均拒绝签发。
2. React 只通过 SSO 登录；现有 Next.js 页面和飞书机器人认证路径的既有测试保持通过。React 首次登录后创建新员工，两名成员之间的报销数据隔离。
3. 从 React、演示 A、演示 B 分别退出后，其他已登录的 SSO 项目下一次受保护请求均拒绝访问；旧 Web JWT、无 `sid` JWT、伪造退出通知不能绕过或误撤销。SSO 状态检查故障时，React BFF 与 Go API 都拒绝受保护请求。
4. 同时启动两套本地服务无端口冲突；React、BFF、Go 的单元/集成测试、类型检查、构建和浏览器流程通过。

## 当前边界

这是本地迁移 Profile 的接入，不改变现有 Next.js 页面和机器人流量。旧员工与新 SSO 员工不自动关联，机器人与 React 的数据可能分离。生产部署仍需独立处理 HTTPS、密钥、服务鉴权、持久会话和多实例运行。
