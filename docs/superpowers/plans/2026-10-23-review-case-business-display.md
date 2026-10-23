# 财务复核案件业务化展示实施计划

> **执行方式：原生执行。** 用户已确认业务化展示设计并要求开始实施。

**目标：** 将复核中心的技术字段替换为财务可理解的异常原因、报销单信息和领取人姓名。

**设计：** 服务端的复核案件投影左连接报销单和员工，React 根据稳定原因码渲染中文文案；页面只显示业务字段并使用既有路由跳转详情。

**设计说明：** `docs/superpowers/specs/2026-10-23-review-case-business-display-design.md`

## Task 1：扩展复核案件 API 投影

**Files:**
- Modify: `services/reimbursement-api/internal/application/review_cases.go`
- Modify: `services/reimbursement-api/internal/store/policy_review_repository.go`
- Modify: `services/reimbursement-api/internal/transport/http/claims_handler_test.go`
- Modify: `api/openapi/reimbursement-v1.yaml`

1. 先写失败的 HTTP 合同测试，断言业务字段以 camelCase 返回。
2. 给领域视图、SQL 查询和 OpenAPI 补充单号、事由和领取人姓名。
3. 运行目标 Go 测试并确认先红后绿。

## Task 2：替换 React 的技术展示

**Files:**
- Modify: `apps/web/src/api/generated/reimbursement.ts`
- Modify: `apps/web/src/routes/review-center-page.tsx`
- Modify: `apps/web/src/routes/review-center-page.test.tsx`
- Modify: `apps/web/src/styles.css`

1. 先写失败的组件测试，覆盖中文异常文案、报销单链接和姓名显示。
2. 更新 API 类型和页面渲染，隐藏原始 ID 与异常码。
3. 使用既有设计令牌和真实 `Link` 保持访问性与导航一致性。

## Task 3：回归验证

1. 运行 Go 全量测试、Web 单测及类型检查/构建中项目已配置的命令。
2. 构建并重启受影响的 Go 服务，检查实际 API 输出。
3. 对复核中心执行静态 UI 审计和浏览器检查；记录无法在当前环境验证的风险。

## 交付备注

- **2026-10-23：已完成并本地验证。** 复核队列已展示中文异常原因、关联报销单号与事由、领取人姓名；不再向财务页面暴露原始 ID 或异常码。相关 Go/React 测试、Web 构建、静态 UI 审计和容器重建已完成。
