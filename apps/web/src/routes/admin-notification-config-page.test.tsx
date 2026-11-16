import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { reimbursementApi } from "../api/client";
import { AdminNotificationConfigPage } from "./admin-notification-config-page";

vi.mock("../api/client", () => ({ reimbursementApi: {
  getAdminConfigDomain: vi.fn(), listConfigHistory: vi.fn(), saveConfigDomainDraft: vi.fn(),
  previewConfigDomainDraft: vi.fn(), publishConfigDomainDraft: vi.fn(), activateConfigVersion: vi.fn(),
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("previews only wired Feishu events and saves a disabled event", async () => {
  vi.mocked(reimbursementApi.getAdminConfigDomain).mockResolvedValue({});
  vi.mocked(reimbursementApi.listConfigHistory).mockResolvedValue({ items: [] });
  vi.mocked(reimbursementApi.saveConfigDomainDraft).mockImplementation(async (_, input) => ({ domain: "notification_templates", revision: 1, payload: input.payload, authorId: "admin-1", note: input.note, approvedBy: "", publishedRevision: 0 }));
  const user = userEvent.setup();
  render(<MemoryRouter><AdminNotificationConfigPage isAdmin /></MemoryRouter>);
  expect(await screen.findByText("通知模板与事件开关")).toBeVisible();
  expect(screen.queryByRole("option", { name: "Web" })).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "启用飞书通知" }));
  await user.type(screen.getByLabelText("变更说明"), "暂停识别完成通知");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(reimbursementApi.saveConfigDomainDraft).toHaveBeenCalledWith("notification_templates", expect.objectContaining({ payload: expect.objectContaining({ events: expect.arrayContaining([expect.objectContaining({ eventCode: "ReceiptExtractionCompleted", enabled: false })]) }) }));
});
