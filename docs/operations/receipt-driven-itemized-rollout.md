# 票据驱动明细：灰度验收

本清单用于测试环境。新草稿的明细模式由 Go API 启动时读取的 `REIMBURSEMENT_ITEMIZED_EMPLOYEE_IDS` 控制；空值保持新建草稿走旧模式。已创建草稿的模式保存在单据中，调整名单不会转换已有草稿。Go Worker 仅在 `MODEL_PROVIDER=openai-compatible` 且配置 `MODEL_BASE_URL`、`MODEL_NAME` 时启用分类；模型失败仍保留 OCR 金额，并把类别留给人工处理。

## 启用前

1. 按 [本地迁移说明](local-sso-react.md) 的顺序，在目标测试环境备份后应用 Go SQL 迁移 `000019` 至 `000022`；检查旧草稿与已提交单据仍可读，旧提交快照没有变化。不要清空数据库或数据卷。
2. 先设置两名**不同员工 ID** 的名单，重启 Go API。Worker 配置分类模型后再重启。核对 API、Worker、Agent 事件消费者和 Web 的部署版本一致。正式扩量前保持名单不变。
3. 记录测试员工、环境、版本、迁移结果、模型名称、开始时间与回退负责人。使用脱敏的打车、餐饮、住宿、交通及无法判定类型票据；不要把票面文字写进日志或验收记录。

已有草稿保持 `LEGACY`，仅在员工明确选定要参与验收的旧草稿后转换。先运行只读预览并核对员工、单号、版本和票据数，再用预览得到的版本执行；并发修改会因版本冲突拒绝转换。转换仅给已识别票据回填已保存的 OCR 金额，未知类型、类别和事由留空；已提交单据不能转换。

```powershell
$employeeId = 'replace-with-employee-id'
$claimId = 'replace-with-claim-id'
docker compose --env-file .env.local --profile migration exec -T reimbursement-api /usr/local/bin/reimbursement-entrypoint /usr/local/bin/convert-itemized-draft --employee-id $employeeId --claim-id $claimId
$previewVersion = 1 # 替换为上一步输出的 version
docker compose --env-file .env.local --profile migration exec -T reimbursement-api /usr/local/bin/reimbursement-entrypoint /usr/local/bin/convert-itemized-draft --employee-id $employeeId --claim-id $claimId --expected-version $previewVersion --apply
```

## 双员工验收

| 场景 | 应观察到的结果 |
| --- | --- |
| 员工 A 从 Web 上传打车票；员工 B 从飞书私聊上传餐饮票 | OCR 后各生成一条明细。已识别金额来自 OCR，类型、类别、通用事由有来源标记；项目编码和同行人没有证据时留空。两端刷新后读取同一份 Go 数据。 |
| 员工 A 在一张草稿内上传打车与餐饮两票 | 两条明细、两个类别、明细合计及概括性整单事由同时出现；飞书私聊通知列出两票且明确类别是建议。 |
| 员工 A 在 Web 改打车明细，随后在飞书读单并指定餐饮明细修改 | 修改仅作用于目标明细；Web 和飞书回读一致。OCR 重试不覆盖人工字段；重复事件不生成第二条明细。 |
| 员工 B 查询或修改员工 A 单据；群聊问个人单据 | 不返回个人数据，不写入明细。旧草稿继续按旧字段办理；已提交单据不可修改。 |
| 未知类别、模型失败、OCR 低置信、重复票及缺失金额 | 显示待人工处理或原有复核状态，不编造类别、金额、项目或同行人；原有提交阻断仍生效。 |
| 修改明细后提交、申请金额与明细合计不同 | 旧确认失效；新确认显示申请金额、明细合计和差额。提交快照含每条明细及票据，政策按明细类别校验。 |

验收时记录脱敏单号、票据 ID、预期与实际类型/类别、人工纠正、提交阻断原因及事件 ID。真实分类质量须用上述类型和模糊票据样本人工复核；结构化 JSON 正确不等于分类正确。

## 观察与扩量

以下查询只汇总测试员工最近七天的新明细，不读取 `ocr_text`。将员工 ID 替换为目标环境的真实测试 ID；查询结果与 Web/Agent 样本逐项核对。

```sql
SELECT i.classification_status, i.receipt_type,
       count(*) AS item_count,
       count(*) FILTER (WHERE i.category_source = 'MANUAL') AS manually_edited_categories
FROM reimbursement.expense_items AS i
JOIN reimbursement.claims AS c ON c.id = i.claim_id
WHERE c.owner_id IN ('employee-a', 'employee-b')
  AND i.created_at >= now() - interval '7 days'
GROUP BY i.classification_status, i.receipt_type
ORDER BY i.classification_status, i.receipt_type;

SELECT r.id AS receipt_id, r.status, c.claim_number
FROM reimbursement.receipts AS r
JOIN reimbursement.claims AS c ON c.id = r.claim_id
LEFT JOIN reimbursement.expense_items AS i ON i.receipt_id = r.id
WHERE c.owner_id IN ('employee-a', 'employee-b')
  AND c.itemization_mode = 'ITEMIZED'
  AND r.status = 'EXTRACTED'
  AND r.created_at >= now() - interval '7 days'
  AND i.id IS NULL;
```

结合 Worker 错误、`outbox_events` 未发布记录、Agent 消费者重试以及 Go 校验响应，逐日统计 OCR/模型失败、错误分类、人工纠正、重复通知和政策阻断。`category_source='MANUAL'` 只是纠正率的近似值，需与人工样本比对。没有明细的已识别票据需排查处理链路。每次扩大名单前，先确认双员工验收、数据一致性和分类样本达到团队约定标准，再记录扩量决定。

## 回退

从 API 环境变量中移除新增测试员工，重启 API，使之后创建的草稿恢复旧模式；如分类服务异常，再关闭 Worker 的 `MODEL_PROVIDER` 并重启 Worker。已存在的 `ITEMIZED` 草稿仍按已保存模式读取和编辑。保留明细、旧单据及历史提交快照；不要删除迁移、表或数据。回退后核对新建草稿模式、旧单据读取及已提交快照。

本地已完成自动化测试；目标环境迁移、真实双员工飞书/Web 操作、脱敏票据分类质量及监控数据需在部署后按本清单执行并记录。
