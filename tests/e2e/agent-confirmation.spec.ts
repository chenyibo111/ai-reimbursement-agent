import { expect, test } from "@playwright/test";

test("lets an employee accept a fixture Agent purpose suggestion and keeps it after reload", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/claims/new");
  await page.getByRole("button", { name: "创建报销草稿" }).click();
  await expect(page).toHaveURL(/\/claims\/[a-z0-9]+$/);
  await page.getByLabel("回复 AI").fill("这是客户拜访支出");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("这是客户拜访支出", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "接受并写入" })).toBeVisible();
  await page.getByRole("button", { name: "接受并写入" }).click();
  await expect(page.getByText("已接受", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("已接受", { exact: true })).toBeVisible();
});

test("keeps chat history visible after synchronizing claim data", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/claims/new");
  await page.getByRole("button", { name: "创建报销草稿" }).click();
  await expect(page).toHaveURL(/\/claims\/[a-z0-9]+$/);

  await page.getByLabel("回复 AI").fill("这是客户拜访支出");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByRole("button", { name: "接受并写入" })).toBeVisible();
  await expect(page.getByText("这是客户拜访支出", { exact: true })).toBeVisible();
});
