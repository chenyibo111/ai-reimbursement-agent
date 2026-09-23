---
version: alpha
name: "AI 报销 Agent"
description: "面向中国企业员工的票据驱动型报销工作台，以清晰的凭证脉络替代冗长填表。"
colors:
  ink: "#13233D"
  cobalt: "#3569E8"
  cobaltSoft: "#EAF0FF"
  paper: "#F7F9FC"
  surface: "#FFFFFF"
  line: "#DCE4F0"
  muted: "#64748B"
  success: "#13806A"
  warning: "#A15C00"
  danger: "#C43A4A"
typography:
  display:
    fontFamily: "'Aptos Display', 'Microsoft YaHei UI', 'PingFang SC', sans-serif"
  sans:
    fontFamily: "'Aptos', 'Microsoft YaHei UI', 'PingFang SC', sans-serif"
  mono:
    fontFamily: "'Cascadia Mono', 'SFMono-Regular', Consolas, monospace"
rounded:
  sm: "0.5rem"
  md: "0.875rem"
  lg: "1.25rem"
spacing:
  page-max: "76rem"
  section-gap: "2rem"
components:
  button: { }
  card: { }
  input: { }
  panel: { }
---

# AI 报销 Agent Design System

## Overview

### Creative North Star

把报销看作一份正在归档的“凭证卷宗”：票据、待补信息和确认结果按处理顺序留下清晰痕迹。员工在忙碌工作间隙只需判断下一步，不必面对会计软件式的密集表单。

### Product context and register

- **Audience and primary job:** 中国单企业员工发起、补齐并提交报销草稿。
- **Target market(s) and evidence:** 中国企业内部报销场景；依据 `docs/superpowers/specs/2026-09-20-ai-reimbursement-agent-design.md`。
- **Locale(s) and language policy:** 简体中文，金额以人民币和两位小数展示；日期以 `YYYY-MM-DD` 编辑。
- **Usage scene:** 桌面优先，也支持手机快速上传；流程会被工作消息打断，因此草稿状态始终可见。
- **Register:** 产品界面。数据与下一步操作优先于品牌装饰。
- **Memorable signature:** “处理脉络”侧栏用一条卷宗式竖向轨迹连接草稿、票据、待补与提交状态。
- **Restraint:** 表单、表格和错误提示保持直接，不使用拟物票据图案或装饰性渐变。
- **Anti-references:** 不做传统财务系统的多栏密集录入台，也不把对话窗口伪装成能绕过校验的助手。
- **Token ownership/runtime mapping:** `app/globals.css` 是运行时 CSS 变量的唯一实现；本文件记录相同语义值并通过 CSS 变量被页面和组件消费。

## Colors

`ink` 用于标题与高权重文字，`cobalt` 只用于主要推进操作和键盘焦点，`paper` 用于页面底色。`success`、`warning` 和 `danger` 只表达状态，并始终配合图标或文字。

## Typography

显示文字使用 `display`，正文和控件使用 `sans`，编号和金额可使用 `mono`。中文正文保持 1.6 行高，避免通过全大写或过度加粗建立层级。

## Layout

主内容最大宽度为 `page-max`，大屏使用处理脉络栏与主工作区的双栏布局；小于 760px 时折叠为单栏。表格由自身横向滚动，不锁定页面高度。

## Elevation & Depth

页面层级主要由纸面色差和细边线表达。仅浮动提示和确认区域使用轻阴影；普通卡片不堆叠阴影。

## Shapes

控件采用 `md` 圆角，状态标签采用 `sm` 圆角。边框低对比且不可替代焦点环。

## Components

### Foundational visual states

可点击元素具有悬停、按下、键盘焦点、禁用与忙碌状态。忙碌按钮保留原有宽度；错误显示在关联字段或操作附近。

### Buttons and actions

蓝色实心按钮仅用于推进当前报销步骤；次要操作使用白底描边。提交前确认与最终提交分两次明确操作。

### Forms and overlays

表单由原生语义控件承载，关闭浏览器原生校验气泡并显示中文可恢复错误。文件上传始终提供文件选择按钮，不依赖拖放。

### Motion

仅使用 160ms 的状态淡入；系统启用减少动态效果时取消过渡。

## Do's and Don'ts

- **Do:** 让员工始终看清当前草稿、阻断项与下一步。
- **Do:** 让服务端校验结果覆盖界面推测的状态。
- **Don't:** 用聊天回复表示已经提交或已经识别成功。
- **Don't:** 用红色代替错误说明，或在状态变化时让布局跳动。
