import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { reimbursementApi, type ReceiptReviewConfig } from "../api/client";
import { AdminReviewConfigPage } from "./admin-review-config-page";

vi.mock("../api/client", () => ({ reimbursementApi: {
  getAdminConfigDomain: vi.fn(), listConfigHistory: vi.fn(), saveConfigDomainDraft: vi.fn(),
  previewReceiptReviewConfig: vi.fn(), approveConfigDomainDraft: vi.fn(),
  publishConfigDomainDraft: vi.fn(), activateConfigVersion: vi.fn(),
} }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows a sample impact preview and requires another administrator to approve", async () => {
  const active: ReceiptReviewConfig = { lowOcrConfidenceThreshold: 0.7, reasonLabels: {} };
  const proposed: ReceiptReviewConfig = { lowOcrConfidenceThreshold: 0.8, reasonLabels: {} };
  vi.mocked(reimbursementApi.getAdminConfigDomain).mockResolvedValue({ active: { domain: "receipt_review", version: 1, payload: active, publishedAt: "2026-11-15T00:00:00Z" } });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [] });
  vi.mocked(reimbursementApi.saveConfigDomainDraft).mockResolvedValue({ domain: "receipt_review", revision: 2, payload: proposed, authorId: "admin-1", note: "提高阈值", approvedBy: "", publishedRevision: 0 });
  vi.mocked(reimbursementApi.previewReceiptReviewConfig).mockResolvedValue({ draft: { domain: "receipt_review", revision: 2, payload: proposed, authorId: "admin-1", note: "提高阈值", approvedBy: "", publishedRevision: 0 }, active: { domain: "receipt_review", version: 1, payload: active, publishedAt: "2026-11-15T00:00:00Z" }, impact: { recentSampleCount: 100, newReviewCount: 12, reducedReviewCount: 0 } });
  render(<MemoryRouter><AdminReviewConfigPage isAdmin actorID="admin-1" /></MemoryRouter>);
  const threshold = await screen.findByLabelText("OCR 低置信度复核阈值");
  await userEvent.setup().clear(threshold);
  await userEvent.setup().type(threshold, "0.8");
  await userEvent.setup().type(screen.getByLabelText("变更说明"), "提高阈值");
  await userEvent.setup().click(screen.getByRole("button", { name: "保存草稿" }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "查看影响" }));
  expect(await screen.findByText(/近 100 张票据样本/)).toBeVisible();
  expect(screen.getByText(/预计新增 12 张复核票据/)).toBeVisible();
  expect(screen.getByRole("button", { name: "复核草稿" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "发布配置" })).toBeDisabled();
});

it("lets a different administrator approve the previewed draft and publish it", async () => {
  const payload: ReceiptReviewConfig = { lowOcrConfidenceThreshold: 0.8, reasonLabels: {} };
  const draft = { domain: "receipt_review", revision: 2, payload, authorId: "admin-1", note: "提高阈值", approvedBy: "", publishedRevision: 0 };
  vi.mocked(reimbursementApi.getAdminConfigDomain).mockResolvedValue({ draft });
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [] });
  vi.mocked(reimbursementApi.previewReceiptReviewConfig).mockResolvedValue({ draft, impact: { recentSampleCount: 20, newReviewCount: 2, reducedReviewCount: 0 } });
  vi.mocked(reimbursementApi.approveConfigDomainDraft).mockResolvedValue({ ...draft, approvedBy: "admin-2" });
  vi.mocked(reimbursementApi.publishConfigDomainDraft).mockResolvedValue({ domain: "receipt_review", version: 1, payload, publishedAt: "2026-11-15T00:00:00Z" });
  const user = userEvent.setup();
  render(<MemoryRouter><AdminReviewConfigPage isAdmin actorID="admin-2" /></MemoryRouter>);
  await user.click(await screen.findByRole("button", { name: "查看影响" }));
  await user.click(screen.getByRole("button", { name: "复核草稿" }));
  await user.click(await screen.findByRole("button", { name: "发布配置" }));
  expect(reimbursementApi.approveConfigDomainDraft).toHaveBeenCalledWith("receipt_review", 2);
  expect(reimbursementApi.publishConfigDomainDraft).toHaveBeenCalledWith("receipt_review", 2);
});
