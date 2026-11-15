# 票据驱动明细：灰度验收

本清单用于测试环境。新草稿的明细模式由 Go API 启动时读取的 `REIMBURSEMENT_ITEMIZED_EMPLOYEE_IDS` 控制；空值保持新建草稿走旧模式。已创建草稿的模式保存在单据中，调整名单不会转换已有草稿。Go Worker 仅在 `MODEL_PROVIDER=openai-compatible` 且配置 `MODEL_BASE_URL`、`MODEL_NAME` 时启用分类；模型失败仍保留 OCR 金额，并把类别留给人工处理。

## 启用前

1. 按 [本地迁移说明](local-sso-react.md) 的顺序，在目标测试环境备份后应用 Go SQL 迁移 `000019` 至 `000026`；检查旧草稿与已提交单据仍可读，旧提交快照没有变化。不要清空数据库或数据卷。`000024` 建立配置版本与审计，`000025` 发布原固定映射的基线版本，`000026` 增加稳定类别编码与历史名称回填。
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
| 员工 A 在“申请报销信息”修改整单最终类别 | 打车、餐饮两条识别结果保持只读；最终类别可多选，并可与识别建议不同。OCR 重试不覆盖人工最终选择；重复事件不生成第二条明细。 |
| 员工 B 查询或修改员工 A 单据；群聊问个人单据 | 不返回个人数据，不写入明细。旧草稿继续按旧字段办理；已提交单据不可修改。 |
| 未知类别、模型失败、OCR 低置信、重复票及缺失金额 | 显示待人工处理或原有复核状态，不编造类别、金额、项目或同行人；原有提交阻断仍生效。 |
| 修改整单类别后提交、申请金额与明细合计不同 | 旧确认失效；申请金额、明细合计和差额仍可核对。提交快照保留最终类别、每条识别明细及票据，政策按整单最终类别校验。 |

验收时记录脱敏单号、票据 ID、预期与实际类型/类别、人工纠正、提交阻断原因及事件 ID。真实分类质量须用上述类型和模糊票据样本人工复核；结构化 JSON 正确不等于分类正确。

## 配置中心第一阶段验收

1. 先确认数据库已有 `expense_catalog` 活动基线版本。管理员打开 `/admin/config`，核对“业务字典”五个默认类别和“智能补单”五种票据类型映射。员工和财务复核员访问该地址应被拒绝；只有 `ADMIN` 可保存、预览、发布和回退。项目编码、同行人仍由员工填写，不在此阶段配置。
2. 用草稿把 `TAXI` 映射的通用事由改成测试文案，填写变更说明，保存并查看字段差异，再发布。记录发布前后版本号和操作者。另一个管理员同时修改同一草稿时应看到版本冲突，核对差异后才能重试。不得为验证而覆盖生产配置。
3. 使用两名灰度测试员工：员工 A 从 Web 上传脱敏打车票，员工 B 从飞书私聊上传脱敏打车票。两端均经 Go 的上传会话、票据入库、Worker OCR 与分类链路；新识别结果应使用当前活动映射版本。再在 A 的一张草稿中加入餐饮票，确认整单默认选中两个类别；员工只修改“申请报销信息”的最终多选类别，票据识别结果保持只读。
4. 在 `/admin/policies` 发布只允许指定类别的测试规则。识别出的 `OTHER` 仍显示“其他”；员工若最终选择了不允许的类别，提交校验应阻断，并显示规则原因。政策知识来源的同步状态不影响票据分类建议。
5. 在“发布记录”填写原因并启用旧版本。之后完成的新票据识别应使用旧映射；此前识别结果、人工最终类别和已提交快照保持原值。核对版本和审计记录。回退只切换活动指针，不删除历史配置版本。

配置版本只记录编码与名称快照：`expense_items.expense_catalog_version` 标明识别使用的版本，`claims.expense_catalog_version` 标明整单最终类别保存时的版本。历史名称能唯一匹配时回填编码；遇到同名多码（例如“交通费”）或未知名称时保留原显示值并标记待核对，由员工选择当前类别，不能自动猜测。

```sql
SELECT a.domain, a.version AS active_version, v.published_at
FROM reimbursement.config_active_versions a
JOIN reimbursement.config_versions v ON v.domain = a.domain AND v.version = a.version
WHERE a.domain = 'expense_catalog';

SELECT action, actor_id, version, previous_version, draft_revision, created_at
FROM reimbursement.config_audit
WHERE domain = 'expense_catalog'
ORDER BY id DESC LIMIT 20;
```

若配置读取暂时失败，Worker 继续使用本进程最后一次成功读取的完整版本并记录告警；首次启动没有有效版本时拒绝分类，不生成虚假的类别。先核对数据库活动指针、版本 payload 和 Worker 错误，再恢复配置读取。若新映射本身有误，用管理员页面激活已验证的旧版本，随后用新票据复测；已保存的识别结果需要人工核对，不会随回退重算。测试环境验收记录应包含版本号、脱敏单号、渠道、预期与实际类别、政策结果、回退结果和未完成项，不保存票面原文或凭据。

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
