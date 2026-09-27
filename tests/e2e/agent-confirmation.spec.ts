import { expect, test } from "@playwright/test";

test("keeps policy-only questions in the keyboard-reachable floating private conversation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post("/api/auth/dev-login");
  const before = await page.request.get("/api/claims?status=ALL");
  const beforeCount = ((await before.json()) as { items?: unknown[] }).items?.length ?? 0;

  await page.goto("/claims");
  const trigger = page.getByRole("button", { name: /报销助理/ });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(page.getByRole("heading", { name: "报销助理" })).toBeVisible();

  await page.getByLabel("向报销助理发送消息").fill("住宿报销规则是什么？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("住宿报销规则是什么？", { exact: true })).toBeVisible();

  const after = await page.request.get("/api/claims?status=ALL");
  const afterCount = ((await after.json()) as { items?: unknown[] }).items?.length ?? 0;
  expect(afterCount).toBe(beforeCount);
});

test("keeps a manually created claim form-only while the assistant remains independent", async ({ page }) => {
  await page.request.post("/api/auth/dev-login");
  await page.goto("/claims/new");
  await page.getByRole("button", { name: "创建报销草稿" }).click();
  await expect(page).toHaveURL(/\/claims\/[a-z0-9]+$/);

  await expect(page.getByRole("heading", { name: "补充说明" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /报销助理/ })).toBeVisible();
});
