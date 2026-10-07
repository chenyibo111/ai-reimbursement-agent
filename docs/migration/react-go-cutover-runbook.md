# React + Go 报销切流 Runbook

## 切流前置条件

1. 取得 PostgreSQL、MinIO 与 NATS 的可恢复备份，并在隔离环境验证恢复。
2. 部署 Go API、Go Worker、NATS 与 Agent event worker；确认健康检查、Outbox 延迟和告警链路正常。
3. 对旧库执行只读导出、导入 Go 数据库，并运行 `npm run migration:reconcile`。差异必须为零。
4. 首批仅配置内部员工与单一渠道到 `REIMBURSEMENT_GO_WRITER_SCOPES`，其余流量保持旧入口。

## 演练步骤

1. 启动迁移服务：`docker compose --profile migration up -d --build`。
2. 执行导出、导入、对账；保存安全的对账摘要，不保存票据正文或对象键。
3. 用内部员工完成 Web 创建、上传、识别、校验、确认、提交；再完成飞书附件与补充信息链路。
4. 在 Grafana 核对 Go API 错误率、Outbox 延迟、NATS 消费滞后、OCR 时延、Agent 授权失败率。
5. 复核业务审计可关联员工、渠道、会话、工具调用与请求 ID。

## 回滚

触发条件：对账差异、提交重复、越权、OCR/事件积压超过阈值或告警持续未恢复。

移除对应 `employeeId@CHANNEL` 灰度范围，停止扩大流量并通知财务。该操作仅影响未来创建；已经由 Go 创建的单据仍由 Go 管理。不得反向同步、删除 Go 记录、清空队列、停止 OCR 或修改历史迁移记录。
