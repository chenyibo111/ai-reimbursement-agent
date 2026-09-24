# UX Contract

## Product context

- Audience: 单企业员工。
- Primary jobs: 创建草稿、上传票据、补齐信息、确认并提交。
- Active locales: `zh-CN`；日期按 `YYYY-MM-DD` 编辑，金额显示为人民币。
- Accessibility target: WCAG 2.2 AA。

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| 草稿、票据、提交生命周期 | `docs/superpowers/specs/2026-09-20-ai-reimbursement-agent-design.md` | 产品与技术设计 | 2026-09-23 |
| 会话和员工归属 | `src/server/session.ts`、`src/server/authorization.ts` | 服务端契约 | 2026-09-23 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`
- Token ownership model: `app/globals.css` 为运行时变量源，`DESIGN.md` 镜像其语义值和意图。
- Supported themes: 浅色。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | `src/ui` 表单组件 | 本文件与 API 契约 | 创建 / 编辑 | 浏览器 E2E |
| Scrollbar | `app/globals.css` | `DESIGN.md` | 无 | 真实浏览器 |
| Select/Listbox | 原生 `<select>` | 浏览器平台控件 | 报销单列表的状态筛选 | 真实浏览器；接受平台自有下拉层 |
| Date | 原生 `input[type=date]` | 浏览器平台控件 | 费用明细日期编辑 | 真实浏览器；接受平台自有日历层 |
| Toast | 页面内 `role=status` | 本文件 | success / error | 浏览器 E2E |
| CRUD | `/api/claims` 路由 | 服务端 API | 创建草稿 / 更新字段 / 提交 | 完整流程 E2E |

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery |
|---|---|---|---|---|---|
| 创建草稿 | 创建报销草稿 | 按钮禁用 | 草稿工作台 | 显示草稿状态 | 保留报销事由和页面内错误 |
| 上传票据 | 文件选择或拖放 | 文件行显示处理中 | 当前工作台 | 票据卡片刷新识别状态、关键字段与金额 | 票据卡片保留失败状态；可重新识别 |
| 更新字段 | 保存字段 | 控件禁用 | 停留当前页 | 刷新草稿版本 | 保留输入与错误 |
| 最终提交 | 确认并提交 | 按钮禁用 | 已提交摘要 | 显示报销单编号 | 重新请求确认摘要 |

## Async and resilience

- 所有变更保守提交，防止重复点击；以服务端返回草稿版本和状态为准。
- 版本冲突提示用户刷新最新草稿；会话过期提示重新登录并保留未提交输入。
- 上传和识别失败不丢弃本地选中的其他文件行。

## Validation

- 表单使用 `noValidate`；必填错误就近显示并聚焦第一个错误字段。
- 服务端错误显示为页面内可读错误，不使用浏览器弹窗。
