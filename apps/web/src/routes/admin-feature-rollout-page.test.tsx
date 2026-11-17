import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { reimbursementApi, type FeatureRollout } from "../api/client";
import { AdminFeatureRolloutPage } from "./admin-feature-rollout-page";

vi.mock("../api/client", () => ({ reimbursementApi: {
  getAdminConfigDomain: vi.fn(), listConfigHistory: vi.fn(), saveConfigDomainDraft: vi.fn(),
  previewConfigDomainDraft: vi.fn(), publishConfigDomainDraft: vi.fn(), activateConfigVersion: vi.fn(),
  getFeatureRolloutAudience: vi.fn(),
} }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("previews a two-employee rollout and keeps department rollout unavailable", async () => {
  const active: FeatureRollout = { mode: "OFF" };
  const draft: FeatureRollout = { mode: "EMPLOYEES", employeeIds: ["employee-1", "employee-2"] };
  vi.mocked(reimbursementApi.getAdminConfigDomain).mockResolvedValue({ active: { domain: "feature_rollout", version: 1, payload: active, publishedAt: "2026-11-15T00:00:00Z" } });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [] });
  vi.mocked(reimbursementApi.getFeatureRolloutAudience).mockResolvedValue({ activeEmployeeCount: 1000 });
  vi.mocked(reimbursementApi.saveConfigDomainDraft).mockResolvedValue({ domain: "feature_rollout", revision: 2, payload: draft, authorId: "admin-1", note: "测试员工灰度", approvedBy: "", publishedRevision: 0 });
  vi.mocked(reimbursementApi.previewConfigDomainDraft).mockResolvedValue({ draft: { domain: "feature_rollout", revision: 2, payload: draft, authorId: "admin-1", note: "测试员工灰度", approvedBy: "", publishedRevision: 0 } });
  render(<MemoryRouter><AdminFeatureRolloutPage isAdmin /></MemoryRouter>);
  await userEvent.setup().selectOptions(await screen.findByLabelText("智能补单范围"), "EMPLOYEES");
  expect(screen.getByRole("option", { name: /指定部门/ })).toBeDisabled();
  await userEvent.setup().type(screen.getByLabelText("员工 ID（每行一个）"), "employee-1{enter}employee-2");
  await userEvent.setup().type(screen.getByLabelText("变更说明"), "测试员工灰度");
  await userEvent.setup().click(screen.getByRole("button", { name: "保存草稿" }));
  expect(reimbursementApi.saveConfigDomainDraft).toHaveBeenCalledWith("feature_rollout", expect.objectContaining({ payload: draft }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "查看影响" }));
  expect(await screen.findByText(/预计 2 名员工/)).toBeVisible();
});

it("estimates the number of employees affected by a percentage rollout", async () => {
  const active: FeatureRollout = { mode: "OFF" };
  const draft: FeatureRollout = { mode: "PERCENT", percent: 1, salt: "release-1" };
  vi.mocked(reimbursementApi.getAdminConfigDomain).mockResolvedValue({ active: { domain: "feature_rollout", version: 1, payload: active, publishedAt: "2026-11-15T00:00:00Z" } });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [] });
  vi.mocked(reimbursementApi.getFeatureRolloutAudience).mockResolvedValue({ activeEmployeeCount: 1000 });
  vi.mocked(reimbursementApi.saveConfigDomainDraft).mockResolvedValue({ domain: "feature_rollout", revision: 2, payload: draft, authorId: "admin-1", note: "按比例灰度", approvedBy: "", publishedRevision: 0 });
  vi.mocked(reimbursementApi.previewConfigDomainDraft).mockResolvedValue({ draft: { domain: "feature_rollout", revision: 2, payload: draft, authorId: "admin-1", note: "按比例灰度", approvedBy: "", publishedRevision: 0 } });
  render(<MemoryRouter><AdminFeatureRolloutPage isAdmin /></MemoryRouter>);
  await userEvent.setup().selectOptions(await screen.findByLabelText("智能补单范围"), "PERCENT");
  await userEvent.setup().clear(screen.getByLabelText("放量比例（%）"));
  await userEvent.setup().type(screen.getByLabelText("放量比例（%）"), "1");
  await userEvent.setup().type(screen.getByLabelText("分组标识"), "release-1");
  await userEvent.setup().type(screen.getByLabelText("变更说明"), "按比例灰度");
  await userEvent.setup().click(screen.getByRole("button", { name: "保存草稿" }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "查看影响" }));
  expect(await screen.findByText(/预计约 10 名员工/)).toBeVisible();
});
