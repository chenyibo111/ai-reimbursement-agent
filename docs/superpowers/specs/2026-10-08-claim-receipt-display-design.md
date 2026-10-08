# 报销单号与票据识别结果展示设计

## 背景与目标

当前 React 工作台只显示报销事由、附件文件名、票据状态和发票号码。原因不是单一前端组件遗漏：Go `Receipt` 领域对象、PostgreSQL `reimbursement.receipts` 表、HTTP 响应和 React 类型均没有开票日期、价税合计与销售方字段；OCR 适配器也只从 PaddleOCR 文本中提取了发票号码。`Claim` 只有内部 UUID 风格的 `id`，没有面向员工和财务人员的业务单号。

本期目标是让员工能在报销单列表和工作台稳定看到：

1. 创建即分配、永不改变的报销单号，格式为 `BXyyyyMMdd-四位流水号`，例如 `BX20261008-0001`。
2. 每张票据的文件名、识别状态、发票号码、开票日期、价税合计（人民币）和销售方名称；同时展示 OCR 总体置信度。
3. 每张报销单的附件数、已识别数、已识别金额合计，以及“仍有金额待补充”的明确提示。

本期不改变提交状态机、重复发票判定、人工复核规则或 Agent 对话流程。OCR 未取到某个字段时，页面必须显示“待补充”，而不是编造值或显示 `￥0.00`。旧票据不强制重新识别。

## 范围与约束

- Go 报销 API 是 `reimbursement` schema 的唯一写入方；React 只通过 `/api/v1` 读取新字段。
- 现有内部 `claim.id` 继续用于 URL、关联与鉴权；业务单号仅是不可变的展示/检索标识，不能替代资源 ID。
- 金额在服务端以 `BIGINT` 的“分”为单位保存和传输，以避免 `float64` 的财务精度问题。接口字段为 `totalAmountCent`，React 使用 `zh-CN` / CNY 格式化。
- 字段未识别必须以 SQL `NULL` 和 API `null` 表示。领域层不以空字符串或 0 混淆“未识别”和“金额为零”。
- 该功能是对已有 API 的加性扩展；现有客户端可忽略新增字段。

## 方案比较与选型

### 方案 A：仅在 React 从文件名或 OCR 原文推测字段

实现快，但浏览器没有 OCR 原文的安全读取路径，且结果不能审计、不能参与总额计算。不同入口（Web、飞书 Agent、未来财务复核）会得到不一致的答案，因此不采用。

### 方案 B：在 Go 领域持久化可展示的规范字段（采用）

OCR HTTP 适配器从现有 PaddleOCR 全文中提取标签明确的字段，结果经领域对象、仓储和 OpenAPI 写入 PostgreSQL。React 仅展示 API 给出的值。这一方案保留 OCR 服务“文本识别”的职责，同时让业务服务拥有标准化金额、日期和汇总的唯一事实源。

### 方案 C：让 OCR Python 服务直接输出发票结构化 JSON

长期可以作为更强的专用发票解析器实现，但会扩大 Python 服务合同、模型测试和跨服务版本兼容范围。本期先把解析策略置于 Go OCR 适配器；未来切换到结构化 OCR 时只替换适配器，不改变领域/API/UI 合同。

## 数据模型

### Claim

`reimbursement.claims` 新增：

```text
claim_number TEXT NOT NULL UNIQUE
```

领域对象增加 `ClaimNumber string`。新建草稿时由应用层取得号码并传入领域构造函数，之后任何 patch、提交或状态变化都不能修改它。

为安全处理并发创建，引入表：

```text
reimbursement.claim_number_counters (
  business_date DATE PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1)
)
```

PostgreSQL 通过单条 `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` 原子递增当日序号；应用层用上海时区（`Asia/Shanghai`）的业务日期格式化为 `BXyyyyMMdd-%04d`。创建事务失败后允许号码留空档，避免为了“连续编号”牺牲并发安全或重试语义。

迁移会按现有 `created_at` 的上海日期及 `(created_at, id)` 稳定排序，为历史记录补齐同一格式的号码，并将每日计数器置为当日最大序号。完成回填后才添加非空与唯一约束。因此现有测试数据也能正常显示业务单号，而无需删库重建。

### Receipt

`reimbursement.receipts` 新增三个可空列：

```text
invoice_date DATE NULL
total_amount_cent BIGINT NULL CHECK (total_amount_cent >= 0)
seller_name TEXT NULL
```

`Receipt`、`OCRResult` 与 `ReceiptView` 新增相应的可选字段。`MarkExtracted` 在同一事务内写入所有 OCR 结果、状态、审计记录和 Outbox 事件；若某个字段没有可靠结果，保留 `NULL`。

金额范围只接受 `0` 到 `9,999,999,999.99` 元等能安全换算至 `BIGINT` 分的输入；解析过程采用字符串到分的转换，不经二进制浮点数。日期只接受明确的 `YYYY-MM-DD`、`YYYY/MM/DD` 或 `YYYY年MM月DD日` 标签化值并标准化为 `DATE`。销售方仅接受紧邻“销售方名称”等明确标签的文本，去除控制字符、截断至合理长度；不能可靠提取时为 `NULL`。

## OCR 解析与错误处理

OCR Python 服务继续返回每页 `text` 与总体 `confidence`，不返回或记录敏感 OCR 原文。Go `HTTPReceiptOCRClient` 连接每页文本后，执行独立、可测试的标签优先解析器：

| 字段 | 识别方式 | 未识别处理 |
|---|---|---|
| 发票号码 | 现有“发票号码/发票号”标签 | `null` |
| 开票日期 | “开票日期/日期”标签及严格日期格式 | `null` |
| 价税合计 | “价税合计（小写）/价税合计/合计”标签后的人民币金额 | `null` |
| 销售方 | “销售方名称”等标签后的文本 | `null` |
| OCR 置信度 | 现有页均值 | 0 到 1 |

解析失败不是 OCR 任务失败：只要 OCR 请求成功，票据依然可以成为 `EXTRACTED`，页面按字段显示待补充。保留当前“低总体置信度阻止提交/转人工复核”的既有行为；本期不新增因日期、金额或销售方缺失而阻止提交的规则，以免把展示增强变成无批准的流程变更。

## API 合同

OpenAPI `Claim` 新增必填 `claimNumber`，并新增面向列表和详情的汇总字段：

```json
{
  "claimNumber": "BX20261008-0001",
  "receiptCount": 3,
  "recognizedReceiptCount": 2,
  "totalAmountCent": 210397,
  "missingAmountReceiptCount": 1
}
```

`totalAmountCent` 是所有已识别且金额不为 null 的票据之和；它不等于用户应提交总额，除非 `missingAmountReceiptCount` 为 0。列表查询在 Go 仓储侧以聚合查询生成汇总，避免为 50 张报销单产生 N+1 附件读取。

OpenAPI `Receipt` 新增可空字段：

```json
{
  "invoiceNumber": "26317000001513684420",
  "invoiceDate": "2026-05-01",
  "totalAmountCent": 10155,
  "sellerName": "上海象鲜网络科技有限公司",
  "ocrConfidence": 0.96
}
```

保留现有字段及 URL，不新增业务写接口。HTTP handler、React generated-shape facade 和 API client 在同一变更中更新，OpenAPI 是唯一外部合同来源。

## 页面体验

### 报销单列表

每张卡片在事由上方显示业务单号；卡片元信息显示“已识别金额 ￥x.xx”及“票据 x 份，已识别 y 份”。若有缺少金额的已识别票据，改为“已识别金额 ￥x.xx · 另有 n 份待补充”，避免误导为完整总额。

### 报销工作台

标题区显示业务单号（可复制的文本）和事由。附件区增加单据摘要：票据数、已识别金额、识别进度。每个附件行保留原状态标签，并在文件名下以可扫描的两列信息显示：

```text
发票号码  26317000001513684420     开票日期  2026-05-01
价税合计  ￥101.55                 销售方    上海象鲜网络科技有限公司
OCR 置信度 96%
```

识别处理中显示“待 OCR 识别”；识别完成但字段为空显示“待补充”。小屏幕按纵向堆叠；字段和值具备可访问的文本标签，不只依赖颜色表达状态。

## 实施边界与文件影响

1. 新建 `000010_claim_numbers_and_receipt_metadata.sql`，迁移、回填并授权上述表/列。
2. 扩展 Go `domain`、`application`、`store` 与 `infrastructure/ocr_client.go`；号码分配以小接口注入，便于内存仓储和 PostgreSQL 测试。
3. 更新 `api/openapi/reimbursement-v1.yaml`、React 类型 facade/API client 与列表、工作台组件及样式。
4. 保持 Agent、旧 Next.js 路由、历史 Prisma 数据和提交/复核逻辑不变。

## 测试与验收

### 自动化测试

- 领域/应用：号码格式、同日并发序号、跨日重置、号码不可变；金额分转换、日期与销售方解析、空字段语义。
- PostgreSQL 集成：迁移后历史单据回填；并发号码唯一；`MarkExtracted` 持久化全部字段；列表聚合正确且只包含可识别金额。
- HTTP/OpenAPI：`GET/POST /api/v1/claims` 和 `GET /receipts` 返回新增字段，非所有者仍不能读取。
- React：列表显示业务单号与部分金额提示；工作台显示完整票据元数据及空字段占位。
- 回归：既有上传、病毒扫描、OCR、重复票据、校验与提交流程全部继续通过。

### 人工验收

1. 新建草稿后立刻在列表和工作台看到 `BXyyyyMMdd-xxxx`，刷新和提交后号码不变。
2. 上传含“发票号码、开票日期、价税合计、销售方”的样票，识别完成后字段和金额与票面一致；两张票据的汇总为两者的精确分值之和。
3. 上传缺少金额或日期的样票，票据仍显示识别完成，但该字段为“待补充”，报销单汇总提示不完整，不显示为零。
4. 原有已识别票据在迁移后仍可查看，缺失的新字段以“待补充”显示，原有发票号码、状态和提交能力不被改变。

## 风险与后续

- 通用 PaddleOCR 对版式变化敏感。本期标签优先解析会宁可漏填、不猜测；后续可将结构化发票 OCR 替换到同一 `OCRClient` 合同中。
- “已识别金额”不是会计审定金额，也不代表已合规；提交前规则校验仍是最终裁决。
- 后续若需要员工修正 OCR 字段，应另行设计带审计记录、原值、修正人和复核规则的写接口，不能让前端直接覆盖 OCR 结果。
