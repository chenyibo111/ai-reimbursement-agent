import { expect, test } from "@playwright/test";

test("employee creates a claim and reaches its Go API-backed workbench", async ({ page }) => {
  await page.route("**/api/v1/claims", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    await route.fulfill({
      status: 201,
      json: {
        id: "claim-e2e", status: "DRAFT", version: 1, purpose: "上海客户拜访",
        expenseCategory: null, participants: [], projectCode: null,
        createdAt: "2026-10-07T08:00:00.000Z", updatedAt: "2026-10-07T08:00:00.000Z",
      },
    });
  });
  await page.route("**/api/v1/claims/claim-e2e", (route) => route.fulfill({ json: {
    id: "claim-e2e", status: "DRAFT", version: 1, purpose: "上海客户拜访",
    expenseCategory: null, participants: [], projectCode: null,
    createdAt: "2026-10-07T08:00:00.000Z", updatedAt: "2026-10-07T08:00:00.000Z",
  } }));
  await page.route("**/api/v1/claims/claim-e2e/receipts", (route) => route.fulfill({ json: { items: [] } }));

  await page.goto("/claims");
  await page.getByRole("button", { name: "新建报销草稿" }).click();
  await page.getByLabel("报销事由").fill("上海客户拜访");
  await page.getByRole("button", { name: "创建并进入工作台" }).click();

  await expect(page).toHaveURL(/\/claims\/claim-e2e$/);
  await expect(page.getByRole("heading", { name: "上海客户拜访" })).toBeVisible();
  await expect(page.getByText("还没有票据。上传后会在这里显示识别进度与结果。")).toBeVisible();
});
