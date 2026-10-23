import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewCenterPage } from "./review-center-page";

const api = vi.hoisted(() => ({
  listReviews: vi.fn(),
  getReview: vi.fn(),
  getReviewReceiptPreview: vi.fn(),
  claimReview: vi.fn(),
  resolveReview: vi.fn(),
}));
const ApiError = vi.hoisted(() => class extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
});

vi.mock("../api/client", () => ({ reimbursementApi: api, ReimbursementApiError: ApiError }));

const openCase = { id: "review-1", claimId: "claim-1", receiptId: "receipt-1", claimNumber: "BX20261023-0001", claimPurpose: "客户拜访", kind: "RECEIPT_OCR", reasonCode: "OCR_LOW_CONFIDENCE", status: "OPEN", assignedTo: "", assignedToDisplayName: "", version: 2, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" } as const;

function renderReviewCenter() {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ReviewCenterPage /></QueryClientProvider></MemoryRouter>);
}

describe("ReviewCenterPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
		vi.restoreAllMocks();
  });

  it("loads an open case and claims it with its current version", async () => {
    api.listReviews.mockResolvedValue({ items: [openCase] });
    api.getReview.mockResolvedValue(openCase);
    api.claimReview.mockResolvedValue({ ...openCase, status: "CLAIMED", assignedTo: "finance-1", version: 3 });
    const user = userEvent.setup();
    renderReviewCenter();

    expect(await screen.findByText("票据识别结果待确认")).toBeVisible();
    expect(await screen.findByRole("link", { name: "BX20261023-0001" })).toHaveAttribute("href", "/claims/claim-1");
    expect(screen.getByText("客户拜访")).toBeVisible();
    expect(screen.queryByText("OCR_LOW_CONFIDENCE")).toBeNull();
    expect(screen.queryByText("review-1")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "领取案件" }));
    await waitFor(() => expect(api.claimReview).toHaveBeenCalledWith("review-1", 2));
  });

  it("shows an empty state when the queue has no cases", async () => {
    api.listReviews.mockResolvedValue({ items: [] });
    renderReviewCenter();
    expect(await screen.findByText("当前没有需要处理的票据复核案件。")).toBeVisible();
  });

  it("shows the reviewer's name instead of the internal employee identifier", async () => {
    const claimedCase = { ...openCase, status: "CLAIMED" as const, assignedTo: "employee-internal-1", assignedToDisplayName: "李财务", version: 3 };
    api.listReviews.mockResolvedValue({ items: [claimedCase] });
    api.getReview.mockResolvedValue(claimedCase);

    renderReviewCenter();

    expect(await screen.findByText("李财务")).toBeVisible();
    expect(screen.queryByText("employee-internal-1")).toBeNull();
  });

  it("opens the original receipt in a new tab after requesting a short-lived preview URL", async () => {
    api.listReviews.mockResolvedValue({ items: [openCase] });
    api.getReview.mockResolvedValue(openCase);
    api.getReviewReceiptPreview.mockResolvedValue({ url: "https://files.example/receipts/receipt-1?signature=safe", expiresAt: "2026-10-23T12:10:00Z" });
		const replace = vi.fn();
		const previewTab = { location: { replace }, close: vi.fn() } as unknown as Window;
		const open = vi.spyOn(window, "open").mockReturnValue(previewTab);
    const user = userEvent.setup();
    renderReviewCenter();

    await user.click(await screen.findByRole("button", { name: "查看原票" }));

		await waitFor(() => expect(api.getReviewReceiptPreview).toHaveBeenCalledWith("review-1"));
		expect(open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(replace).toHaveBeenCalledWith("https://files.example/receipts/receipt-1?signature=safe");
  });

	it("closes the temporary tab and shows a safe error when the original receipt is unavailable", async () => {
		api.listReviews.mockResolvedValue({ items: [openCase] });
		api.getReview.mockResolvedValue(openCase);
		api.getReviewReceiptPreview.mockRejectedValue(new ApiError("RECEIPT_PREVIEW_UNAVAILABLE", "原票暂不可用，请联系系统管理员后重试。", 409));
		const previewTab = { location: { replace: vi.fn() }, close: vi.fn() } as unknown as Window;
		vi.spyOn(window, "open").mockReturnValue(previewTab);
		const user = userEvent.setup();
		renderReviewCenter();

		await user.click(await screen.findByRole("button", { name: "查看原票" }));

		await waitFor(() => expect(previewTab.close).toHaveBeenCalled());
		expect(screen.getByRole("status")).toHaveTextContent("原票暂不可用，请联系系统管理员后重试。");
	});

  it("submits corrected receipt fields with the claimed case version", async () => {
    const claimedCase = { ...openCase, status: "CLAIMED" as const, assignedTo: "finance-1", version: 3 };
    api.listReviews.mockResolvedValue({ items: [claimedCase] });
    api.getReview.mockResolvedValue(claimedCase);
    api.resolveReview.mockResolvedValue({ ...claimedCase, status: "RESOLVED", version: 4 });
    const user = userEvent.setup();
    renderReviewCenter();

    await user.selectOptions(await screen.findByLabelText("处理方式"), "CORRECT_FIELDS");
    await user.type(await screen.findByLabelText("发票号码"), "INV-2026-1");
    await user.type(screen.getByLabelText("开票日期"), "2026-10-14");
    await user.type(screen.getByLabelText("价税合计（分）"), "12345");
    await user.type(screen.getByLabelText("销售方"), "示例商户");
    await user.type(screen.getByLabelText("处理说明"), "已根据原票更正");
    await user.click(screen.getByRole("button", { name: "保存处理结果" }));

    await waitFor(() => expect(api.resolveReview).toHaveBeenCalledWith("review-1", expect.objectContaining({ expectedVersion: 3, action: "CORRECT_FIELDS", invoiceNumber: "INV-2026-1", invoiceDate: "2026-10-14", totalAmountCent: 12345, sellerName: "示例商户" })));
  });

  it("shows the safe duplicate invoice feedback without presenting it as a stale version", async () => {
    const claimedCase = { ...openCase, status: "CLAIMED" as const, assignedTo: "finance-1", version: 3 };
    api.listReviews.mockResolvedValue({ items: [claimedCase] });
    api.getReview.mockResolvedValue(claimedCase);
    api.resolveReview.mockRejectedValue(new ApiError("DUPLICATE_SUBMITTED_INVOICE", "发票号码已在已提交报销单中使用，请核对后重试", 409));
    const user = userEvent.setup();
    renderReviewCenter();

    await user.type(await screen.findByLabelText("处理说明"), "确认原始识别结果");
    await user.click(screen.getByRole("button", { name: "保存处理结果" }));

    await waitFor(() => expect(screen.getAllByText("发票号码已在已提交报销单中使用，请核对后重试")).toHaveLength(2));
    expect(screen.queryByText("案件已被其他操作更新，请刷新后重试。")).toBeNull();
  });
});
