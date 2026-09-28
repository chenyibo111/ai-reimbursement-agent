# 异步任务与人工复核中心设计

## 1. 目标与范围

将耗时、会短暂失败或需要人工判断的 OCR 提取与政策来源同步，从 Web 请求中移出，统一纳入 PostgreSQL 持久化任务队列。新增受限的人工复核工作台，使财务复核员可以处理票据识别异常，管理员可以处理政策同步异常。

本期包含：

- `EMPLOYEE`、`FINANCE_REVIEWER`、`ADMIN` 三类员工角色；
- 票据 OCR 提取和飞书政策同步的异步任务、原子领取、重试与失败留存；
- 低置信 OCR、识别失败、重复票据进入人工复核；
- `/admin/reviews` 人工复核中心及受限 API；
- 常驻 `job-worker` 进程与 Docker Compose 编排；
- 任务、复核和业务字段变更的可追溯审计。

本期不包含：

- 主管/财务审批流、付款、ERP/OA 同步；
- Redis、BullMQ 或多区域分布式调度；
- 通用人工标注平台、批量处理、SLA 通知；
- 将飞书消息处理或普通模型问答迁入人工复核队列。

## 2. 已确认产品规则

| 主体 | 权限 |
|---|---|
| `EMPLOYEE` | 仅创建和查看自己的报销单；只看到“处理中”或“需要补充”，不读取内部错误、复核意见或其他员工任务。 |
| `FINANCE_REVIEWER` | 查看和领取票据 OCR 复核；可确认、修正白名单票据字段、要求员工补充或关闭无效票据。不能处理政策来源。 |
| `ADMIN` | 拥有财务复核员全部权限；可查看、重试或关闭政策同步任务；负责人员角色配置。 |

- 角色来自服务端数据库的 `Employee.role`，默认 `EMPLOYEE`；浏览器、Cookie 与飞书事件不能传入或覆盖角色。
- 提取任务只保存 `claimId`、`receiptId` 与最小安全错误码，不保存对象键、附件二进制、飞书 token、完整 OCR 原文或模型提示词。
- 政策同步任务只保存 `sourceId`，仅管理员可见。
- 同一“任务类型 + 业务对象”在 `PENDING`、`RUNNING` 或 `RETRY_WAIT` 中最多一项；重复上传或重复点击只复用现有未完成任务。
- OCR 自动成功且没有低置信/重复问题时不创建人工复核任务。
- 人工修正票据字段沿用既有草稿版本与审计边界，不能绕过提交前校验。

## 3. 架构选择

采用 PostgreSQL 任务表作为第一期队列，不新增 Redis：

```text
上传票据 / 管理员同步政策
        ↓
AsyncJob（PENDING）
        ↓
job-worker 原子领取（RUNNING + lease）
        ↓
成功 → SUCCEEDED
临时失败 → RETRY_WAIT（指数退避，最多 3 次）
不可重试失败 / 人工判断 → REVIEW_REQUIRED
        ↓
ReviewCase（OPEN） → 人工领取 → RESOLVED / CLOSED
```

Worker 使用 PostgreSQL 的条件更新领取任务，不以进程内内存作为锁。每次执行重新读取 Receipt、ClaimDraft、PolicySource 的权威状态；任务参数只定位对象，不是事实来源。

任务执行复用 `extractReceipt` 与 `syncPolicySource` 用例。为防止 OCR 重试重复创建费用明细，提取用例必须以 `receiptId` 检查或原子创建关联费用项；成功任务永不再次执行。

## 4. 数据模型

### Employee

新增 `EmployeeRole`：`EMPLOYEE`、`FINANCE_REVIEWER`、`ADMIN`，默认 `EMPLOYEE`。本期管理员角色由数据库迁移后的首个明确配置动作授予，不再依赖仅适用于政策管理的环境变量白名单。

### AsyncJob

字段：`id`、`kind`（`RECEIPT_EXTRACTION` / `POLICY_SOURCE_SYNC`）、`status`（`PENDING` / `RUNNING` / `RETRY_WAIT` / `REVIEW_REQUIRED` / `SUCCEEDED` / `CLOSED`）、`claimId`、`receiptId`、`policySourceId`、`attemptCount`、`maxAttempts`、`availableAt`、`leaseUntil`、`failureCode`、`result`、创建与更新时间。

- `result` 仅保存安全的统计值、任务结果类别和关联复核单 ID。
- 数据库约束保证每个任务恰好关联一种业务对象；代码保证任务种类与对象匹配。
- 局部唯一索引防止同一业务对象出现多个未完成同类任务。
- `leaseUntil` 过期的 `RUNNING` 任务可被 Worker 恢复为可重试状态。

### ReviewCase

字段：`id`、`kind`（`RECEIPT_OCR` / `POLICY_SYNC`）、`status`（`OPEN` / `CLAIMED` / `RESOLVED` / `CLOSED`）、`jobId`、`claimId`、`receiptId`、`policySourceId`、`reasonCode`、`assignedReviewerId`、`resolution`、创建、领取与解决时间。

- 每个 `REVIEW_REQUIRED` 任务最多产生一个开放复核单。
- `CLAIMED` 状态由条件更新领取，避免两位复核员同时处理。
- OCR 复核可编辑：金额、开票日期、发票号、费用类别；编辑值必须经既有验证、版本冲突和审计机制处理。
- “要求补充”创建既有 Clarification；“关闭”保留附件与理由但不创建费用项。

## 5. 任务生命周期

### OCR

1. 上传成功后仅创建 `RECEIPT_EXTRACTION` 任务，HTTP 响应返回票据已保存、识别处理中。
2. Worker 领取任务，执行安全检查后的既有提取用例。
3. Provider 网络/临时服务错误进入 `RETRY_WAIT`，退避为 1 分钟、5 分钟、30 分钟；达到上限转 `REVIEW_REQUIRED`，原因码为 `OCR_RETRY_EXHAUSTED`。
4. OCR 输出金额、日期或发票号低于既有配置阈值，或发现重复票据时，任务完成但创建 `RECEIPT_OCR` 复核单；员工只看到需要补充或处理中状态。
5. 提取成功且无复核条件，任务转 `SUCCEEDED`，保持现有 OCR、费用明细、校验与审计结果。

### 政策同步

1. 管理员点击同步只创建或复用 `POLICY_SOURCE_SYNC` 任务，立即返回任务 ID。
2. Worker 调用既有 `syncPolicySource`。旧活动快照继续服务，直到新快照完整激活。
3. 文档读取、Embedding 或网络错误按相同退避重试；达到上限转 `REVIEW_REQUIRED`，仅管理员可见。
4. 管理员可以重试或关闭复核任务；重新尝试只创建安全的新任务，不直接篡改历史任务。

## 6. API 与界面

### 员工接口

- 既有上传接口改为返回 `receiptId` 与 `jobStatus=PENDING`，不等待 OCR。
- 草稿详情的票据卡以任务状态显示“识别处理中”“需要补充”或既有识别结果；不暴露失败码、领取人或内部复核备注。

### 管理接口

- `GET /api/admin/reviews`：按类型、状态、分页读取授权范围内复核单。
- `POST /api/admin/reviews/{id}/claim`：财务复核员或管理员领取 OCR 单。
- `POST /api/admin/reviews/{id}/resolve`：仅领取人或管理员解决；支持 `CONFIRM`、`CORRECT_FIELDS`、`REQUEST_INFORMATION`、`CLOSE`。
- `POST /api/admin/reviews/{id}/retry`：仅管理员重试政策同步；OCR 重试同样要求领取权与任务仍可重试。
- `GET/PATCH /api/admin/employees/{id}/role`：仅管理员读取与更新角色；禁止用户提升自身角色，至少保留一个管理员。

`/admin/reviews` 采用任务表格和详情抽屉：列表提供状态、类型、创建时间、领取人和安全原因摘要；详情显示关联票据/政策来源及可执行动作。所有异步状态拥有加载、空、错误、冲突和权限不足状态。

## 7. Worker 与部署

- 新增 `src/worker/job-worker.ts`，轮询间隔由 `JOB_WORKER_POLL_INTERVAL_MS` 配置，默认 1 秒；每轮领取有限数量任务并串行处理，避免压垮 OCR 服务。
- Docker Compose 新增与 Web 使用同一镜像和环境变量的 `job-worker` 服务；Web 与 Worker 可以独立扩容。
- Worker 启动时回收过期 lease；正常关机不删除任务。
- 任务日志只记录 `jobId`、种类、状态、尝试次数和安全错误码，不记录凭据、对象键或附件内容。

## 8. 安全、审计与失败边界

- 每次入队、领取、开始、重试、成功、转人工、关闭、字段修正与角色变更都写审计事件；政策同步审计可复用或扩展政策审计表，票据复核写 ClaimDraft 审计事件。
- API 每次从签名会话获取 actor，再从数据库加载角色；不依赖页面隐藏按钮作为权限控制。
- 员工、复核员、管理员访问均校验关联 ClaimDraft/PolicySource 的存在与状态；已删除对象对应任务安全关闭。
- Worker 对未知异常使用 `INTERNAL_RETRYABLE`，达到上限进入复核；未知业务对象、权限/格式错误使用不可重试安全码并关闭或转复核。
- 复核解决必须使用期望版本，发生版本冲突时保持复核单 `CLAIMED` 并要求刷新。

## 9. 验收标准

1. 上传票据请求不等待 OCR；Worker 最终将其成功、重试或送入人工复核，且重启 Worker 不丢任务。
2. 同一票据不会因重复请求或 lease 恢复而重复创建费用明细。
3. OCR 低置信、重复票据和达到重试上限的失败能生成恰好一个 OCR 复核单。
4. 只有财务复核员/管理员能读取或领取 OCR 复核；只有管理员能处理政策同步复核与角色配置。
5. 两位复核员并发领取同一单时，仅一人成功；非领取人不能覆盖其解决结果。
6. 员工不会得到内部失败详情，但可以从自己的草稿看到可执行的下一步。
7. 管理员触发政策同步后接口立即返回；失败不会破坏旧活动政策快照。
8. 每个状态迁移、字段修正、任务重试和角色变更均可审计；接口、日志和数据库任务参数不暴露凭据、对象键或附件二进制。
