# Go 票据人工复核案件队列设计

## 1. 目标与范围

将 Go 报销服务中已经被标记为 `REVIEW_REQUIRED` 的异常票据，转换为财务人员可领取、可处理、可审计的 `ReviewCase` 队列。完成后，“需要人工复核”不再只是员工侧状态，而是有明确归属、处理动作和最终结果的业务闭环。

本期仅覆盖票据 OCR 复核：

- 重复文件内容、与已提交报销单重复的发票号、低 OCR 置信度、OCR 重试耗尽；
- 财务复核员与管理员的列表、领取、详情和结案；
- 更正票据字段、确认识别、要求重新上传、关闭无效票据；
- 报销单、票据、复核案件之间的一致性与审计。

本期不包含政策来源同步复核、角色后台管理、审批流、付款、ERP/OA 对接和批量复核。恶意文件继续走安全隔离路径，不进入财务 OCR 复核队列。

## 2. 现状与问题

当前 Go OCR 链路会把异常票据的 `receipts.status` 更新为 `REVIEW_REQUIRED`，并写入 `receipt_review_issues`。但是它没有创建 `review_cases`，而 React `/admin/reviews` 只能手工输入案件编号调用结案接口。因此异常票据没有可领取待办，复核员也无法知道处理对象、原因或关联报销单。

当前提交校验以 `ocr_confidence < 0.7` 作为阻断条件。本期将这个阈值作为低置信度案件的唯一阈值，避免“可提交但被复核”或“不可提交却没有复核案件”的不一致。

## 3. 复核生命周期

```text
票据异常
  └─ 同一事务：票据状态 + 原因记录 + ReviewCase + 审计 + Outbox
       └─ OPEN
            ├─ 领取（条件更新）→ CLAIMED
            │    ├─ 确认识别 / 更正字段 → RESOLVED，票据 EXTRACTED
            │    └─ 要求重新上传 / 关闭无效 → CLOSED，票据 QUARANTINED
            └─ 管理员可直接处理，仍保留领取与解决审计
```

每张票据最多有一个未关闭案件。重复消息投递、Worker 重试或用户重复点击不会创建第二个待办，也不会追加相同原因码。

触发条件如下：

| 场景 | 原因码 | 处理位置 |
| --- | --- | --- |
| 上传完成时命中同内容哈希 | `DUPLICATE_CONTENT` | `FinalizeReceiptUpload` |
| OCR 提取出已提交的同发票号 | `DUPLICATE_SUBMITTED_INVOICE` | `ExtractReceipt` |
| OCR 完成但平均置信度低于 0.7 | `LOW_OCR_CONFIDENCE` | `ExtractReceipt` |
| JetStream OCR 消费达到最大投递次数 | `OCR_RETRY_EXHAUSTED` | `reimbursement-worker` |

`MALWARE_DETECTED` 继续仅隔离并保留安全审计；财务复核员不应接触可疑文件。

## 4. 数据模型与迁移

新增迁移以扩展现有 `reimbursement.review_cases`：

- `receipt_id`：关联 `receipts.id`，本期 OCR 案件必填；
- `reason_code`：安全原因码；
- `claimed_at`：首次领取时间；
- `version`：从 `1` 开始，用于领取和处理的乐观并发控制；
- `updated_at`：状态变迁的最后更新时间。

迁移还会：

1. 为 `receipt_review_issues (receipt_id, code)` 添加唯一约束，先去除既有重复记录；
2. 为 `review_cases` 添加“同一票据仅一个开放/已领取案件”的局部唯一索引；
3. 回填已是 `REVIEW_REQUIRED` 但尚无案件的历史票据。回填优先使用该票据最早的原因码，缺失时使用 `LEGACY_REVIEW_REQUIRED`；
4. 保留既有案件和审计记录，不删除测试数据。

创建或复用 OCR 案件必须由同一 PostgreSQL 事务完成。实现将收敛目前分散的“标记票据待复核”和“创建复核案件”写入，而不是依靠 Worker 的后置补偿。

## 5. 复核动作

复核案件保持 `OPEN`、`CLAIMED`、`RESOLVED`、`CLOSED` 四种状态。

| 动作 | 授权 | 结果 |
| --- | --- | --- |
| `CLAIM` | `FINANCE_REVIEWER`、`ADMIN` | 原子从 `OPEN` 变为 `CLAIMED`，记录领取人和时间 |
| `CONFIRM` | 领取人或 `ADMIN` | 确认当前 OCR 字段，票据转 `EXTRACTED`，案件转 `RESOLVED` |
| `CORRECT_FIELDS` | 领取人或 `ADMIN` | 校验并写入发票号、日期、金额、销售方；再次验证已提交发票号重复；成功后票据转 `EXTRACTED`、案件转 `RESOLVED` |
| `REQUEST_REUPLOAD` | 领取人或 `ADMIN` | 票据转 `QUARANTINED`、案件转 `CLOSED`；员工仅看到安全的“请重新上传票据”提示 |
| `CLOSE_INVALID` | 领取人或 `ADMIN` | 票据转 `QUARANTINED`、案件转 `CLOSED` |

`CONFIRM` 不适用于仍命中 `DUPLICATE_SUBMITTED_INVOICE` 的结果；复核员必须更正字段，或关闭该票据。字段更正不会直接修改已经提交的报销单。每个动作要求客户端传入 `expectedVersion`；版本不匹配时返回冲突，案件保持原状态。

员工不能读取 `reason_code`、领取人、内部处理结论或审计内容。员工侧仅显示“正在人工复核”或“票据不可用，请删除后重新上传”。

## 6. HTTP API

新增/扩展以下 Go API，并同步 OpenAPI 和 React 生成类型：

- `GET /api/v1/admin/reviews?status=OPEN&limit=50`：返回仅 OCR 类型案件的分页列表；
- `GET /api/v1/admin/reviews/{reviewId}`：返回案件、关联报销单安全摘要、票据字段与原因码；
- `POST /api/v1/admin/reviews/{reviewId}/claim`：领取开放案件，要求 `expectedVersion`；
- `POST /api/v1/admin/reviews/{reviewId}/resolve`：提交动作、`expectedVersion`、可选字段更正。

`EMPLOYEE` 一律返回 `403`，`FINANCE_REVIEWER` 与 `ADMIN` 可以读取 OCR 案件；只有领取人或管理员可完成处理。所有端点继续依赖现有 Go API 的签名 JWT、员工活动状态与角色校验，不信任前端传入的员工或角色。

## 7. React 复核中心

将 `/admin/reviews` 从手工输入案件 ID 的临时表单替换为真正的复核工作台：

- 待办列表显示原因、票据文件名、报销单号、创建时间、状态和领取人；
- 点击条目加载右侧详情，展示 OCR 结构化字段和关联报销单摘要；
- 开放案件显示“领取”；已领取案件显示可执行的确认、更正、要求重新上传和关闭按钮；
- 更正操作以字段表单提交，并处理加载、空列表、403、409 和网络失败状态；
- 只在前端改善可发现性，所有权限和版本校验仍以 API 结果为准。

该页面使用既有 React Router、TanStack Query、样式与 API Client，不新增 UI 框架。

## 8. 审计、事件与失败处理

以下操作写入 `review_case_audits`：案件创建/复用、领取、确认、更正、要求重新上传和关闭。票据状态变化继续写入票据审计与 Outbox。

`CORRECT_FIELDS` 发生发票号重复或版本冲突时，事务回滚，案件保持 `CLAIMED`，不会遗失原始 OCR 结果。已删除的草稿票据收到过期 OCR 消息时仍按既有逻辑确认消息，不创建幽灵案件。

业务阻断错误（重复内容、重复已提交发票、低置信度）不会触发无意义的 OCR 重新投递。仅临时 OCR/网络错误可重试；达到上限后创建或复用 `OCR_RETRY_EXHAUSTED` 案件并确认消息。

## 9. 验收与测试

1. 四类异常均生成恰好一条可领取的 OCR 案件，重复投递不重复建案；
2. 两位复核员并发领取时仅一人成功；非领取人不能处理，管理员可以接管；
3. 更正后的字段通过校验后票据恢复 `EXTRACTED`，仍重复的发票号不能被确认；
4. 重新上传/关闭后票据不可提交，员工不见内部原因；
5. 普通员工无法列出、读取、领取或结案；
6. 列表、详情、领取、处理均有 Go HTTP/API 测试与 React 交互测试；
7. 完整 Go、React、Node 测试套件及 Docker Compose 配置校验通过。

## 10. 后续边界

政策同步复核、管理员角色维护、员工补充说明工作流和批量处理不属于本期。它们可复用 `ReviewCase` 的状态、审计和列表接口模式，但不应在本次 OCR 闭环中预先实现。

## 实施备注

**2026-10-23：本期 OCR 票据复核闭环已在本地完成验证。** 队列创建、领取、处理、员工侧安全反馈与财务侧原票预览均已落地；本节列出的后续边界仍不属于当前交付。
