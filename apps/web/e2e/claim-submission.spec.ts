import { expect, test } from "@playwright/test";

test("employee creates a claim and reaches its Go API-backed workbench", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await page.route("**/api/auth/access-token", (route) => route.fulfill({
    json: {
      accessToken: "e2e-token",
      expiresAt,
      employee: { id: "employee-e2e", displayName: "测试员工", role: "EMPLOYEE" },
    },
  }));
  const created = {
    id: "claim-e2e", claimNumber: "BX-E2E-0001", status: "DRAFT", version: 1, purpose: "上海客户拜访",
    expenseCategory: null, participants: [], projectCode: null, receiptCount: 0, recognizedReceiptCount: 0,
    totalAmountCent: null, missingAmountReceiptCount: 0, requestedAmountCent: null, currency: "CNY",
    requestedAmountSource: "MANUAL", remark: null,
    createdAt: "2026-10-07T08:00:00.000Z", updatedAt: "2026-10-07T08:00:00.000Z",
  };
  await page.route(/\/api\/v1\/claims(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { items: [], totalCount: 0, nextCursor: null } });
      return;
    }
    await route.fulfill({ status: 201, json: created });
  });
  await page.route("**/api/v1/claims/claim-e2e", (route) => route.fulfill({ json: { ...created, version: route.request().method() === "PATCH" ? 2 : 1 } }));
  await page.route("**/api/v1/claims/claim-e2e/receipts", (route) => route.fulfill({ json: { items: [] } }));

  await page.goto("/claims");
  await page.getByRole("link", { name: "新建报销单" }).click();
  await page.getByLabel("报销事由").fill("上海客户拜访");
  await page.getByRole("button", { name: "保存草稿" }).click();

  await expect(page).toHaveURL(/\/claims\/claim-e2e$/);
  await expect(page.getByRole("heading", { name: "上海客户拜访" })).toBeVisible();
  await expect(page.getByText("还没有票据。上传后会在这里显示识别进度与结果。")).toBeVisible();
});

test("admin previews, publishes, and activates an earlier catalog version", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const categories = [
    { code: "LOCAL_TRANSPORT", label: "市内交通费", aliases: [], enabled: true, sortOrder: 10 },
    { code: "DINING", label: "餐饮费", aliases: [], enabled: true, sortOrder: 20 },
    { code: "LODGING", label: "住宿费", aliases: [], enabled: true, sortOrder: 30 },
    { code: "TRANSPORT", label: "交通费", aliases: [], enabled: true, sortOrder: 40 },
    { code: "OTHER", label: "其他", aliases: [], enabled: true, sortOrder: 50 },
  ];
  const first = { categories, mappings: [
    { receiptType: "TAXI", categoryCode: "LOCAL_TRANSPORT", purposeTemplate: "市内出行打车费" },
    { receiptType: "DINING", categoryCode: "DINING", purposeTemplate: "餐饮费用" },
    { receiptType: "LODGING", categoryCode: "LODGING", purposeTemplate: "住宿费用" },
    { receiptType: "TRANSPORT", categoryCode: "TRANSPORT", purposeTemplate: "交通出行费用" },
    { receiptType: "OTHER", categoryCode: "OTHER", purposeTemplate: "其他费用" },
  ] };
  const next = { ...first, mappings: [{ ...first.mappings[0], purposeTemplate: "市内交通出行费" }, ...first.mappings.slice(1)] };
  let active = { domain: "expense_catalog", version: 1, payload: first, publishedAt: "2026-11-01T00:00:00Z" };
  let draft: { domain: string; revision: number; publishedRevision: number; payload: typeof first; authorId: string; note: string } | undefined;
  await page.route("**/api/auth/access-token", (route) => route.fulfill({ json: { accessToken: "admin-token", expiresAt, employee: { id: "admin-e2e", displayName: "测试管理员", role: "ADMIN" } } }));
  await page.route("**/api/v1/admin/config/expense_catalog", (route) => route.fulfill({ json: { active, draft } }));
  await page.route("**/api/v1/admin/config/expense_catalog/history", (route) => route.fulfill({ json: { items: [
    { action: "PUBLISHED", actorId: "admin-e2e", version: 1, previousVersion: 0, draftRevision: 0, note: "基线", at: "2026-11-01T00:00:00Z" },
    ...(active.version === 2 ? [{ action: "PUBLISHED", actorId: "admin-e2e", version: 2, previousVersion: 1, draftRevision: 1, note: "更新", at: "2026-11-02T00:00:00Z" }] : []),
  ] } }));
  await page.route("**/api/v1/admin/config/expense_catalog/draft", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.expectedRevision).toBe(draft?.revision ?? 0);
    draft = { domain: "expense_catalog", revision: (draft?.revision ?? 0) + 1, publishedRevision: draft?.publishedRevision ?? 0, payload: body.payload, authorId: "admin-e2e", note: body.note };
    await route.fulfill({ json: draft });
  });
  await page.route("**/api/v1/admin/config/expense_catalog/preview", (route) => route.fulfill({ json: { draft, active } }));
  await page.route("**/api/v1/admin/config/expense_catalog/publish", async (route) => {
    expect(route.request().postDataJSON().revision).toBe(draft?.revision);
    active = { ...active, version: 2, payload: next };
    draft!.publishedRevision = draft!.revision;
    await route.fulfill({ json: active });
  });
  await page.route("**/api/v1/admin/config/expense_catalog/activate", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ expectedActiveVersion: 2, version: 1 });
    active = { ...active, version: 1, payload: first };
    await route.fulfill({ json: active });
  });

  await page.goto("/admin/config");
  await expect(page.getByRole("heading", { name: "报销配置" })).toBeVisible();
  await page.getByRole("tab", { name: "智能补单" }).click();
  await page.getByLabel("通用事由").first().fill("市内交通出行费");
  await page.getByLabel("变更说明").fill("更新打车默认事由");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "查看影响" }).click();
  await expect(page.getByText(/市内出行打车费 → 市内交通出行费/)).toBeVisible();
  await page.getByRole("button", { name: "发布配置" }).click();
  await expect(page.getByText("当前发布版本 2")).toBeVisible();
  await page.getByRole("tab", { name: "发布记录" }).click();
  await page.getByLabel("回退说明").fill("恢复基线");
  await page.getByRole("button", { name: "启用版本 1" }).click();
  await expect(page.getByText("当前发布版本 1")).toBeVisible();
  await page.getByRole("tab", { name: "智能补单" }).click();
  await expect(page.getByLabel("通用事由").first()).toHaveValue("市内出行打车费");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "发布记录" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("mixed receipt suggestions can be changed for the final claim while policy blocks submission", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const claim = {
    id: "claim-mixed", claimNumber: "BX-E2E-001", ownerId: "employee-e2e", status: "DRAFT", version: 3,
    itemizationMode: "ITEMIZED", purpose: "市内出行及餐饮费用", expenseCategory: null,
    selectedExpenseCategoryCodes: ["LOCAL_TRANSPORT", "DINING"], selectedExpenseCategories: ["市内交通费", "餐饮费"],
    participants: [], projectCode: null, receiptCount: 2, recognizedReceiptCount: 2, totalAmountCent: 9000,
    missingAmountReceiptCount: 0, expenseItemTotalAmountCent: 9000, requestedAmountCent: 9000,
    currency: "CNY", requestedAmountSource: "OCR_SUGGESTED", remark: null,
    expenseItems: [
      { id: "taxi", claimId: "claim-mixed", receiptId: "taxi", receiptType: "TAXI", classificationStatus: "CLASSIFIED", expenseCategory: "市内交通费", categoryCode: "LOCAL_TRANSPORT", categorySource: "MODEL", purpose: "市内出行打车费", purposeSource: "MODEL", amountCent: 3800, amountSource: "OCR", projectCode: "", participants: [] },
      { id: "dining", claimId: "claim-mixed", receiptId: "dining", receiptType: "DINING", classificationStatus: "CLASSIFIED", expenseCategory: "餐饮费", categoryCode: "DINING", categorySource: "MODEL", purpose: "餐饮费用", purposeSource: "MODEL", amountCent: 5200, amountSource: "OCR", projectCode: "", participants: [] },
    ],
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };
  let finalCodes: string[] = [];
  await page.route("**/api/auth/access-token", (route) => route.fulfill({ json: { accessToken: "employee-token", expiresAt, employee: { id: "employee-e2e", displayName: "测试员工", role: "EMPLOYEE" } } }));
  await page.route("**/api/v1/claims/claim-mixed", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      finalCodes = body.selectedExpenseCategoryCodes ?? claim.selectedExpenseCategoryCodes;
      await route.fulfill({ json: { ...claim, version: 4, selectedExpenseCategoryCodes: finalCodes } });
      return;
    }
    await route.fulfill({ json: { ...claim, version: finalCodes.length ? 4 : 3, selectedExpenseCategoryCodes: finalCodes.length ? finalCodes : claim.selectedExpenseCategoryCodes } });
  });
  await page.route("**/api/v1/claims/claim-mixed/receipts", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/config/expense_catalog", (route) => route.fulfill({ json: { domain: "expense_catalog", version: 2, payload: { categories: [
    { code: "LOCAL_TRANSPORT", label: "市内交通费", enabled: true, aliases: [], sortOrder: 10 },
    { code: "DINING", label: "餐饮费", enabled: true, aliases: [], sortOrder: 20 },
    { code: "OTHER", label: "其他", enabled: true, aliases: [], sortOrder: 30 },
  ] } } }));
  await page.route("**/api/v1/claims/claim-mixed/submission-requests", (route) => route.fulfill({ status: 422, json: { code: "VALIDATION_BLOCKED", message: "当前政策不允许其他类别" } }));
  await page.route("**/api/v1/claims/claim-mixed/validation", (route) => route.fulfill({ json: { claimId: claim.id, claimVersion: 4, policyVersion: "policy-1", issues: [{ code: "CATEGORY_NOT_ALLOWED", severity: "BLOCKING", message: "当前政策不允许其他类别" }] } }));

  await page.goto("/claims/claim-mixed");
  await expect(page.getByRole("heading", { name: "费用明细" })).toBeVisible();
  await expect(page.getByText("第 1 条 · 票据 1")).toBeVisible();
  await expect(page.getByText("第 2 条 · 票据 2")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "市内交通费" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "餐饮费" })).toBeChecked();
  await page.getByRole("checkbox", { name: "市内交通费" }).uncheck();
  await page.getByRole("checkbox", { name: "其他" }).check();
  await page.getByRole("button", { name: "提交报销单" }).click();
  await expect(page.getByText("当前政策不允许其他类别")).toBeVisible();
  expect(finalCodes).toEqual(["DINING", "OTHER"]);
  await expect(page.getByRole("heading", { name: "费用明细" })).toBeVisible();
});
