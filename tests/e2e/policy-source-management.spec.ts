import { expect, test } from "@playwright/test";

test("lets an allowlisted administrator add, disable, and re-enable a policy source", async ({ page }) => {
  const token = `E2EPolicy${Date.now()}`;
  const title = `E2E 差旅制度 ${token}`;
  await page.request.post("/api/auth/dev-login");
  await page.goto("/admin/policy-sources");

  await expect(page.getByRole("heading", { name: "政策知识来源" })).toBeVisible();
  await page.getByLabel("来源标题").fill(title);
  await page.getByLabel("飞书链接").fill(`https://acme.feishu.cn/docx/${token}`);
  await page.getByRole("button", { name: "添加来源" }).click();
  await expect(page.getByText("来源已添加，请手动同步。")).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const source = page.locator(".policy-rule-preview li").filter({ hasText: title });

  await source.getByRole("button", { name: "停用来源" }).click();
  await expect(page.getByText("来源已停用，不会参与政策问答。")).toBeVisible();
  await expect(source.getByRole("button", { name: "立即同步" })).toBeDisabled();

  await source.getByRole("button", { name: "重新启用" }).click();
  await expect(page.getByText("来源已启用，可再次手动同步。")).toBeVisible();
  await expect(source.getByRole("button", { name: "立即同步" })).toBeEnabled();
});
