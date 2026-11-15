import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { reimbursementApi, ReimbursementApiError } from "../api/client";
import { AdminConfigPage } from "./admin-config-page";

const catalog = {
  categories: [
    { code: "LOCAL_TRANSPORT", label: "市内交通费", aliases: ["打车费"], enabled: true, sortOrder: 10 },
    { code: "DINING", label: "餐饮费", aliases: [], enabled: true, sortOrder: 20 },
  ],
  mappings: [{ receiptType: "TAXI", categoryCode: "LOCAL_TRANSPORT", purposeTemplate: "市内出行打车费" }],
};

vi.mock("../api/client", () => ({
  ReimbursementApiError: class ReimbursementApiError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
  reimbursementApi: {
    getAdminConfig: vi.fn(), saveConfigDraft: vi.fn(), previewConfigDraft: vi.fn(),
    publishConfigDraft: vi.fn(), activateConfigVersion: vi.fn(), listConfigHistory: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reimbursementApi.getAdminConfig).mockResolvedValue({ active: { domain: "expense_catalog", version: 1, payload: catalog, publishedAt: "2026-11-01T00:00:00Z" } });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [{ action: "PUBLISHED", actorId: "admin", version: 1, previousVersion: 0, draftRevision: 0, note: "", at: "2026-11-01T00:00:00Z" }] });
});
afterEach(cleanup);

it("keeps configuration editing unavailable to non-admin employees", () => {
  render(<MemoryRouter><AdminConfigPage isAdmin={false} /></MemoryRouter>);
  expect(screen.getByText("当前账号没有配置管理权限。")).toBeVisible();
  expect(reimbursementApi.getAdminConfig).not.toHaveBeenCalled();
});

it("switches configuration tabs with the keyboard", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><AdminConfigPage isAdmin /></MemoryRouter>);
  await screen.findByDisplayValue("市内交通费");
  const dictionary = screen.getByRole("tab", { name: "业务字典" });
  dictionary.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "智能补单" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel", { name: "智能补单" })).toBeVisible();
  await user.keyboard("{End}");
  expect(screen.getByRole("tab", { name: "发布记录" })).toHaveFocus();
});

it("saves a catalog draft, previews the field difference, then publishes", async () => {
  const user = userEvent.setup();
  vi.mocked(reimbursementApi.saveConfigDraft).mockResolvedValue({ domain: "expense_catalog", revision: 1, payload: catalog, authorId: "admin", note: "调整打车类别", approvedBy: "" });
  vi.mocked(reimbursementApi.previewConfigDraft).mockResolvedValue({ draft: { domain: "expense_catalog", revision: 1, payload: { ...catalog, categories: [{ ...catalog.categories[0], label: "市区交通费" }, catalog.categories[1]] }, authorId: "admin", note: "调整打车类别", approvedBy: "" }, active: { domain: "expense_catalog", version: 1, payload: catalog, publishedAt: "2026-11-01T00:00:00Z" } });
  vi.mocked(reimbursementApi.publishConfigDraft).mockResolvedValue({ domain: "expense_catalog", version: 2, payload: catalog, publishedAt: "2026-11-02T00:00:00Z" });
  render(<MemoryRouter><AdminConfigPage isAdmin /></MemoryRouter>);
  const label = await screen.findByDisplayValue("市内交通费");
  await user.clear(label);
  await user.type(label, "市区交通费");
  await user.type(screen.getByLabelText("变更说明"), "调整打车类别");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(reimbursementApi.saveConfigDraft).toHaveBeenCalledWith("expense_catalog", expect.objectContaining({ expectedRevision: 0, payload: expect.objectContaining({ categories: expect.arrayContaining([expect.objectContaining({ label: "市区交通费" })]) }) })));
  await user.click(screen.getByRole("button", { name: "查看影响" }));
  expect(await screen.findByText(/市内交通费 → 市区交通费/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "发布配置" }));
  await waitFor(() => expect(reimbursementApi.publishConfigDraft).toHaveBeenCalledWith("expense_catalog", 1));
});

it("permits rollback from history and reloads the server state", async () => {
  const user = userEvent.setup();
  const newer = { ...catalog, categories: [{ ...catalog.categories[0], label: "新版交通费" }, catalog.categories[1]] };
  const publishedDraft = { domain: "expense_catalog", revision: 2, publishedRevision: 2, payload: newer, authorId: "admin", note: "新版", approvedBy: "" };
  vi.mocked(reimbursementApi.getAdminConfig)
    .mockResolvedValueOnce({ active: { domain: "expense_catalog", version: 2, payload: newer, publishedAt: "2026-11-02T00:00:00Z" }, draft: publishedDraft })
    .mockResolvedValueOnce({ active: { domain: "expense_catalog", version: 1, payload: catalog, publishedAt: "2026-11-01T00:00:00Z" }, draft: publishedDraft });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [
    { action: "PUBLISHED", actorId: "admin", version: 1, previousVersion: 0, draftRevision: 0, note: "", at: "2026-11-01T00:00:00Z" },
    { action: "PUBLISHED", actorId: "admin", version: 2, previousVersion: 1, draftRevision: 1, note: "", at: "2026-11-02T00:00:00Z" },
  ] });
  vi.mocked(reimbursementApi.activateConfigVersion).mockResolvedValue({ domain: "expense_catalog", version: 1, payload: catalog, publishedAt: "2026-11-01T00:00:00Z" });
  render(<MemoryRouter><AdminConfigPage isAdmin /></MemoryRouter>);
  await user.click(await screen.findByRole("tab", { name: "发布记录" }));
  await user.type(screen.getByLabelText("回退说明"), "映射需要复核");
  await user.click(screen.getByRole("button", { name: "启用版本 1" }));
  await waitFor(() => expect(reimbursementApi.activateConfigVersion).toHaveBeenCalledWith("expense_catalog", { expectedActiveVersion: 2, version: 1, note: "映射需要复核" }));
  await waitFor(() => expect(reimbursementApi.getAdminConfig).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("tab", { name: "业务字典" }));
  expect(screen.getByDisplayValue("市内交通费")).toBeVisible();
});

it("preserves local edits after a version conflict until the admin chooses to reload", async () => {
  const user = userEvent.setup();
  const next = { ...catalog, categories: [{ ...catalog.categories[0], label: "新版交通费" }, catalog.categories[1]] };
  vi.mocked(reimbursementApi.getAdminConfig)
    .mockResolvedValueOnce({ active: { domain: "expense_catalog", version: 1, payload: catalog, publishedAt: "2026-11-01T00:00:00Z" } })
    .mockResolvedValueOnce({ active: { domain: "expense_catalog", version: 2, payload: next, publishedAt: "2026-11-02T00:00:00Z" } })
    .mockResolvedValue({ active: { domain: "expense_catalog", version: 2, payload: next, publishedAt: "2026-11-02T00:00:00Z" } });
  vi.mocked(reimbursementApi.saveConfigDraft).mockRejectedValue(new ReimbursementApiError("CONFIG_CONFLICT", "配置版本已更新", 409));
  render(<MemoryRouter><AdminConfigPage isAdmin /></MemoryRouter>);
  const label = await screen.findByDisplayValue("市内交通费");
  await user.clear(label);
  await user.type(label, "本地修改");
  await user.type(screen.getByLabelText("变更说明"), "本地说明");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(await screen.findByText(/配置已被其他管理员更新/)).toBeVisible();
  expect(screen.getByDisplayValue("本地修改")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "载入最新版本" }));
  expect(await screen.findByDisplayValue("新版交通费")).toBeVisible();
});
