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
| React 报销工作台与员工归属 | `apps/web/src`、`services/reimbursement-api` 的 `/api/v1` | Go API 契约 | 2026-10-07 |
| 会话和员工归属（遗留） | `src/server/session.ts`、`src/server/authorization.ts` | 服务端契约 | 2026-09-23 |
| 跨渠道私有会话与受控办理 | `docs/superpowers/specs/2026-09-27-cross-channel-agent-conversation-design.md`、`app/api/conversations/private/*` | 产品与 API 契约 | 2026-09-27 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`
- Token ownership model: React 报销入口以 `apps/web/src/styles.css` 为运行时样式源；遗留 Next.js 页面继续由 `app/globals.css` 承担。`DESIGN.md` 镜像二者共同的语义值和意图。
- Supported themes: 浅色。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | `apps/web/src/routes` 表单组件 | 本文件与 Go `/api/v1` 契约 | 创建 / 编辑 | 浏览器 E2E |
| Scrollbar | `apps/web/src/styles.css` | `DESIGN.md` | 无 | 真实浏览器 |
| Select/Listbox | 原生 `<select>` | 浏览器平台控件 | 报销单列表的状态筛选 | 真实浏览器；接受平台自有下拉层 |
| Date | 原生 `input[type=date]` | 浏览器平台控件 | 费用明细日期编辑 | 真实浏览器；接受平台自有日历层 |
| Toast | 页面内 `role=status` | 本文件 | success / error | 浏览器 E2E |
| CRUD | Go `/api/v1/claims` | Go 服务端 API | 创建草稿 / 上传 / 校验 / 提交 | 完整流程 E2E |
| 政策管理 | `/api/admin/policies` 路由与 `src/ui/policy-version-editor.tsx` | 服务端政策版本与白名单授权 | 创建草稿 / 保存规则 / 发布版本 | 政策管理 E2E |
| 政策知识来源 | `/api/admin/policy-sources` 路由与 `src/ui/policy-source-manager.tsx` | 服务端来源、快照与白名单授权 | 添加 / 停用 / 重新启用 / 手动同步 | 来源管理 E2E |
| 私有 Agent 会话 | `src/ui/agent-conversation-widget.tsx` | `/api/conversations/private/*` 与服务端会话归属 | 折叠 / 展开 / 附件 / 确认提交 | 单元测试、浏览器键盘与窄屏复核 |
| 政策问答依据 | `src/ui/agent-conversation-widget.tsx` 的原生 `<details>` 证据卡 | 已保存的服务端检索引用快照 | 收起 / 展开原文片段 | 单元测试、浏览器键盘与窄屏复核 |
| 人工复核中心 | `src/ui/review-center.tsx` | `/api/admin/reviews` 与服务端数据库角色 | 领取 / 更正 / 补充信息 / 关闭 / 政策重试 | 单元测试、管理 API 集成测试、浏览器键盘与窄屏复核 |

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery |
|---|---|---|---|---|---|
| 创建草稿 | 创建报销草稿 | 按钮禁用 | 草稿工作台 | 显示草稿状态 | 保留报销事由和页面内错误 |
| 上传票据 | 文件选择或拖放 | 文件行显示处理中 | 当前工作台 | 票据卡片刷新识别状态、关键字段与金额 | 票据卡片保留失败状态；可重新识别 |
| 更新字段 | 保存字段 | 控件禁用 | 停留当前页 | 刷新草稿版本 | 保留输入与错误 |
| 最终提交 | 确认并提交 | 按钮禁用 | 已提交摘要 | 显示报销单编号 | 服务端重新校验；阻断项返回提交前检查 |
| 创建政策草稿 | 管理员填写名称与生效日期 | 创建按钮禁用 | 留在政策管理页并选中草稿 | 页面内“已创建政策草稿”状态 | 保留输入并显示服务端错误 |
| 保存政策规则 | 管理员保存草稿规则 | 保存按钮禁用 | 停留当前草稿 | 页面内“规则已保存”状态 | 版本冲突提示刷新后重新保存 |
| 发布政策版本 | 页面内二次确认发布 | 确认按钮禁用 | 留在只读版本详情 | 页面内“政策已发布”状态 | 保留确认区域并显示可恢复错误 |
| 管理知识来源 | 管理员添加、停用或重新启用来源 | 当前来源的操作按钮禁用 | 停留来源管理页 | 页面内成功状态与最新来源状态 | 保留来源及上一次成功快照，显示安全失败原因 |
| 同步知识来源 | 管理员手动同步已启用来源 | 当前来源的操作按钮禁用 | 停留来源管理页 | 显示切片数或原文未变化 | 保留上一次成功快照，显示安全失败原因 |
| 查看政策问答依据 | 展开“检索依据” | 无异步请求 | 停留当前工作台 | 展示章节、匹配度、命中原文与原文链接 | 无命中时不显示依据卡；原文链接在新标签页打开 |
| 私有 Agent 问答 | 右下角“报销助理” | 发送按钮禁用，保留输入 | 停留当前页面 | 刷新已保存的私有历史与依据 | 保留输入并显示可重新加载的页面内错误 |
| 对话中上传票据 | 助理面板的“上传票据” | 操作按钮禁用 | 停留当前页面 | 刷新 Intake，必要时显示工作台链接 | 原文件不被误报为成功；显示服务端安全错误 |
| 对话确认提交 | 仅 `READY_TO_SUBMIT` 的“确认提交” | 提交按钮禁用 | 停留当前页面 | 以服务端提交结果刷新 Intake | 服务端重新校验后显示可恢复错误，不显示乐观提交状态 |
| 人工复核 | 复核员从队列领取任务 | 当前任务操作按钮禁用 | 停留复核中心 | 服务端确认后刷新队列与任务详情 | 保留输入；版本冲突提示刷新后重试，不向员工暴露内部错误码 |

## Async and resilience

- 所有变更保守提交，防止重复点击；以服务端返回草稿版本和状态为准。
- 版本冲突提示用户刷新最新草稿；会话过期提示重新登录并保留未提交输入。
- 上传和识别失败不丢弃本地选中的其他文件行。

## Validation

- 表单使用 `noValidate`；必填错误就近显示并聚焦第一个错误字段。
- 服务端错误显示为页面内可读错误，不使用浏览器弹窗。
