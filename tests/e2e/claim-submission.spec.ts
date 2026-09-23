import { expect, test } from "@playwright/test";

test("shows the authenticated employee a clear starting point for a new reimbursement claim", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/claims/new");

  await expect(page.getByRole("heading", { name: "发起报销" })).toBeVisible();
  await page.getByLabel("报销事由").fill("客户拜访交通费用");
  await page.getByRole("button", { name: "创建报销草稿" }).click();

  await expect(page).toHaveURL(/\/claims\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { name: "报销工作台" })).toBeVisible();
});

test("lets an employee complete a missing reimbursement purpose from the workspace", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/claims/new");

  await page.getByRole("button", { name: "创建报销草稿" }).click();
  await expect(page).toHaveURL(/\/claims\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { name: "报销工作台" })).toBeVisible();

  await page.getByLabel("报销事由").fill("客户午餐");
  await page.getByRole("button", { name: "保存报销事由" }).click();
  await expect(page.getByText("报销事由已保存。", { exact: true })).toBeVisible();
});
