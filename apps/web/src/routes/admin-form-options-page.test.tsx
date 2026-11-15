import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { reimbursementApi } from "../api/client";
import { AdminFormOptionsPage } from "./admin-form-options-page";

vi.mock("../api/client", () => ({ reimbursementApi: {
  getAdminConfigDomain: vi.fn(), listConfigHistory: vi.fn(), saveConfigDomainDraft: vi.fn(),
  previewConfigDomainDraft: vi.fn(), publishConfigDomainDraft: vi.fn(), activateConfigVersion: vi.fn(),
} }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("saves and previews form options before offering publication", async () => {
  const payload = { categoryHelpText: "", projectCodeMode: "FREE_TEXT" as const, projectCodes: [], fieldOrder: [] };
  vi.mocked(reimbursementApi.getAdminConfigDomain).mockResolvedValue({ active: { domain: "form_options", version: 1, payload, publishedAt: "2026-11-15T00:00:00Z" } });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [] });
  vi.mocked(reimbursementApi.saveConfigDomainDraft).mockResolvedValue({ domain: "form_options", revision: 1, payload: { ...payload, categoryHelpText: "请按实际费用选择" }, authorId: "admin-1", note: "更新提示", approvedBy: "", publishedRevision: 0 });
  vi.mocked(reimbursementApi.previewConfigDomainDraft).mockResolvedValue({ draft: { domain: "form_options", revision: 1, payload: { ...payload, categoryHelpText: "请按实际费用选择" }, authorId: "admin-1", note: "更新提示", approvedBy: "", publishedRevision: 0 }, active: { domain: "form_options", version: 1, payload, publishedAt: "2026-11-15T00:00:00Z" } });
  render(<MemoryRouter><AdminFormOptionsPage isAdmin /></MemoryRouter>);
  await userEvent.setup().type(await screen.findByLabelText("费用类别提示语"), "请按实际费用选择");
  await userEvent.setup().type(screen.getByLabelText("变更说明"), "更新提示");
  await userEvent.setup().click(screen.getByRole("button", { name: "保存草稿" }));
  expect(reimbursementApi.saveConfigDomainDraft).toHaveBeenCalledWith("form_options", expect.objectContaining({ expectedRevision: 0, payload: expect.objectContaining({ categoryHelpText: "请按实际费用选择" }) }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "查看影响" }));
  expect(await screen.findByRole("heading", { name: "影响预览" })).toBeVisible();
  expect(screen.getByText(/费用类别提示语：.*请按实际费用选择/)).toBeVisible();
  expect(screen.getByRole("button", { name: "发布配置" })).toBeEnabled();
});
