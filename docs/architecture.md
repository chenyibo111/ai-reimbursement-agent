# 架构边界

报销单、费用明细、校验结果和审计事件存于 PostgreSQL；原始票据存于 MinIO。OCR 服务仅负责把受控附件转换为结构化字段。

Agent 的信任链路为：服务端从草稿构造脱敏上下文 → 模型返回回复和字段建议 → 服务端校验目标、字段和值 → 保存 `AgentFieldProposal` → 员工确认或忽略 → 单一事务更新草稿、建议状态和审计事件。

## 报销政策规则

`PolicyVersion`、`PolicyRule` 和 `PolicyAuditEvent` 存于 PostgreSQL。只有生效日期不晚于当前时间的 `PUBLISHED` 版本参与校验；`DRAFT` 可编辑，发布事务会归档旧的已发布版本。规则引擎只接受四种预定义类型及其 Zod 校验后的 JSON 配置，不执行脚本、SQL 或模型生成的表达式。

草稿校验、提交确认和最终提交都会读取当前有效政策，并与基础校验结果合并。最终提交在同一数据库事务中重新读取政策、重新校验并写入 `SubmissionSnapshot.payload.policy`；其中保存可追溯的版本信息和本次命中的规则结果，后续政策发布不会重写历史事实。

员工只读接口返回可展示的版本和规则摘要。管理员写入接口始终从签名会话取得员工 ID，再基于其飞书 `open_id` 与 `POLICY_ADMIN_FEISHU_OPEN_IDS` 白名单鉴权；浏览器传入的身份、角色或版本状态不可信。

## 政策知识库

政策原文以管理员在 `/admin/policy-sources` 显式登记的飞书 Docx 或 Wiki 链接为唯一入口。`PolicySource` 的资源 token 仅保存在数据库并仅供同步服务读取；任何浏览器响应都不返回该字段。同步会创建不可变的 `PolicyDocumentSnapshot` 与向量化的 `PolicyChunk`，全部切片完成后才切换为活动快照。读取、解析或嵌入失败时，旧活动快照继续可用，来源记录只保存安全的失败类别。

检索只搜索已启用来源的活动快照。员工对话和飞书机器人均只可得到带来源链接的命中片段；无命中时必须明确说明没有可引用的政策，不得用模型推测制度结论。停用来源会立即排除其内容，重新启用后需管理员手动同步。

模型从不接收数据库 ID、对象键、原始附件、Cookie 或密钥。`expense-1` 等目标引用仅是上下文中的公开别名，服务端保留其与 `ExpenseItem` 的映射。

## 运行可观测性

应用服务输出白名单结构化 JSON 日志，由 Alloy 从 Docker stdout 收集并写入 Loki；Grafana 只经私有运维入口查询 Loki。运行日志与 PostgreSQL 业务审计分离：前者用于诊断并按 30 天留存，后者保存提交、任务和复核的可追溯事实。

Loki Ruler 将告警规则状态发送给 Docker 内网的 Alertmanager，由它负责按规则名、服务和严重级别分组、去重、抑制与重试。内部 `alert-relay` 仅接收 Alertmanager webhook，白名单化告警字段后才调用飞书专用告警群 Webhook；该 Relay、Alertmanager、Loki 与 Grafana 都不暴露主机端口。飞书消息不含业务数据、原始日志或凭据。当前没有固定域名和受控 Grafana 外部入口，因此告警卡片不提供外部仪表盘链接。

日志关联字段包括 `requestId`、`jobId`、`claimId`、`receiptId`、`traceId` 与 `spanId`。其中前四者和 Trace 字段是 JSON 正文而非 Loki 标签；标签只保留低基数的服务、环境、级别、事件和任务种类。日志序列化器会丢弃未知字段，因此对象键、附件字节、Cookie、token、飞书 open_id、OCR 原文、提示词和向量不得写入平台。

当前 Trace 边界兼容 W3C `traceparent`：Web 请求可安全提取 `traceId` 和 `spanId` 写入现有日志字段，但本期不部署 OpenTelemetry Collector 或 Tempo。后续接入 OpenTelemetry 时应沿用这些字段，并保持 Loki 查询和告警规则不变。

## 禁止的行为

- 模型直接修改字段、删除附件、生成提交确认或提交报销单。
- 浏览器在确认接口中发送字段和值；接口只接受建议 ID 和草稿版本。
- 飞书或其他渠道绕过应用层建议与确认边界。
- 大模型、飞书机器人或浏览器直接创建、发布、修改政策规则，或绕过政策阻断项提交报销单。
