import { expect, test } from "@playwright/test";

test("shows the current policy page to an authenticated employee", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/policies");

  await expect(page.getByRole("heading", { name: "当前报销政策" })).toBeVisible();
  await expect(page.getByText("提交前检查只执行已发布的结构化规则")).toBeVisible();
});

test("lets an allowlisted policy administrator create rules and publish a draft", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/admin/policies");

  await expect(page.getByRole("heading", { name: "政策规则管理" })).toBeVisible();
  await page.getByLabel("政策名称").fill("E2E 差旅制度");
  await page.getByLabel("生效日期").fill("2027-01-01");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByText("已创建政策草稿。")).toBeVisible();

  await page.getByLabel("规则名称").fill("总额提醒");
  await page.getByLabel("规则代码").fill("E2E_TOTAL_WARNING");
  await page.getByLabel("金额上限（元）").fill("1000");
  await page.getByLabel("处理级别").selectOption("WARNING");
  await page.getByRole("button", { name: "添加到草稿" }).click();
  await page.getByRole("button", { name: "保存规则" }).click();
  await expect(page.getByText("规则已保存。")).toBeVisible();

  await page.getByRole("button", { name: "发布此版本" }).click();
  await expect(page.getByRole("heading", { name: /确认发布/ })).toBeVisible();
  await page.getByRole("button", { name: "确认发布" }).click();
  await expect(page.getByText("政策已发布，后续报销校验将使用此版本。")).toBeVisible();
});
