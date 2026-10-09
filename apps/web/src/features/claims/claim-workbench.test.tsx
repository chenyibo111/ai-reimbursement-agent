import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { ClaimWorkbenchPage } from "../../routes/claim-workbench-page";
import { shouldRefreshClaimAfterReceiptTransition } from "./use-claim";

vi.mock("../../api/client", () => ({
  reimbursementApi: {
    getClaim: vi.fn().mockResolvedValue({
      id: "claim-1",
		claimNumber: "BX20261007-0001",
      status: "DRAFT",
      version: 1,
      purpose: "广州客户拜访",
      expenseCategory: null,
      participants: [],
      projectCode: null,
		receiptCount: 1,
		recognizedReceiptCount: 0,
		totalAmountCent: null,
		missingAmountReceiptCount: 0,
		requestedAmountCent: null,
		currency: "CNY",
		requestedAmountSource: "OCR_SUGGESTED",
		remark: null,
      createdAt: "2026-10-07T08:00:00.000Z",
      updatedAt: "2026-10-07T08:00:00.000Z",
    }),
    listReceipts: vi.fn().mockResolvedValue({
      items: [
        {
          id: "receipt-1",
          claimId: "claim-1",
          filename: "hotel.png",
          status: "READY_FOR_OCR",
          invoiceNumber: "",
		invoiceDate: null,
		totalAmountCent: null,
		sellerName: null,
          ocrConfidence: 0,
          updatedAt: "2026-10-07T08:00:00.000Z",
        },
      ],
    }),
		deleteReceipt: vi.fn().mockResolvedValue(undefined),
		updateClaim: vi.fn().mockResolvedValue({
			id: "claim-1", claimNumber: "BX20261007-0001", status: "DRAFT", version: 2, purpose: "广州客户拜访", expenseCategory: null, participants: [], projectCode: null,
			receiptCount: 1, recognizedReceiptCount: 0, totalAmountCent: null, missingAmountReceiptCount: 0,
			requestedAmountCent: null, currency: "CNY", requestedAmountSource: "OCR_SUGGESTED", remark: null,
			createdAt: "2026-10-07T08:00:00.000Z", updatedAt: "2026-10-07T08:00:00.000Z",
		}),
    getValidation: vi.fn().mockResolvedValue({
      claimId: "claim-1",
      claimVersion: 1,
      policyVersion: "baseline-v1",
      issues: [{ code: "RECEIPT_PROCESSING", severity: "BLOCKING", message: "票据仍在识别中" }],
    }),
    requestSubmission: vi.fn().mockResolvedValue({ confirmationToken: "confirmation-1" }),
    submit: vi.fn().mockResolvedValue({ claimId: "claim-1", status: "SUBMITTED" }),
  },
}));

describe("ClaimWorkbenchPage", () => {
	afterEach(cleanup);

  it("refreshes the claim once when OCR changes from pending to complete", () => {
    expect(shouldRefreshClaimAfterReceiptTransition(false, true)).toBe(false);
    expect(shouldRefreshClaimAfterReceiptTransition(true, true)).toBe(false);
    expect(shouldRefreshClaimAfterReceiptTransition(true, false)).toBe(true);
  });

  it("shows OCR-pending receipt and exposes one direct submit action", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/claims/claim-1"]}>
          <Routes>
            <Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("OCR 处理中")).toBeVisible();
		expect(screen.getByText("BX20261007-0001")).toBeVisible();
		expect(screen.getByText("待 OCR 识别")).toBeVisible();
    expect(screen.getByRole("button", { name: "提交报销单" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "检查提交条件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "请求提交确认" })).not.toBeInTheDocument();
  });

  it("submits through the internal validation and confirmation calls", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { reimbursementApi } = await import("../../api/client");
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/claims/claim-1"]}>
          <Routes><Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "提交报销单" }));

    await waitFor(() => expect(reimbursementApi.requestSubmission).toHaveBeenCalledWith("claim-1", 2));
    await waitFor(() => expect(reimbursementApi.submit).toHaveBeenCalledWith("claim-1", "confirmation-1"));
  });

	it("requires confirmation before deleting a draft receipt", async () => {
		const user = userEvent.setup();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { reimbursementApi } = await import("../../api/client");
		render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter initialEntries={["/claims/claim-1"]}>
					<Routes><Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} /></Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);

		const deleteButton = await screen.findByRole("button", { name: "删除附件" });
		await user.click(deleteButton);
		expect(screen.getByRole("alertdialog", { name: "删除附件" })).toBeVisible();
		await user.click(screen.getByRole("button", { name: "取消" }));
		await waitFor(() => expect(deleteButton).toHaveFocus());

		await user.click(deleteButton);
		await user.click(screen.getByRole("button", { name: "确认删除" }));
		await waitFor(() => expect(reimbursementApi.deleteReceipt).toHaveBeenCalledWith("claim-1", "receipt-1"));
	});

	it("does not offer attachment deletion after a claim is submitted", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { reimbursementApi } = await import("../../api/client");
		vi.mocked(reimbursementApi.getClaim).mockResolvedValueOnce({
			id: "claim-submitted", claimNumber: "BX20261009-0001", status: "SUBMITTED", version: 2, purpose: "已提交报销", expenseCategory: null, participants: [], projectCode: null,
			receiptCount: 1, recognizedReceiptCount: 1, totalAmountCent: 10155, missingAmountReceiptCount: 0,
			requestedAmountCent: 10155, currency: "CNY", requestedAmountSource: "OCR_SUGGESTED", remark: null,
			createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z",
		});
		render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter initialEntries={["/claims/claim-submitted"]}>
					<Routes><Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} /></Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(await screen.findByText("已提交报销")).toBeVisible();
		expect(screen.queryByRole("button", { name: "删除附件" })).not.toBeInTheDocument();
	});

	it("keeps the confirmation open when attachment deletion fails", async () => {
		const user = userEvent.setup();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { reimbursementApi } = await import("../../api/client");
		vi.mocked(reimbursementApi.deleteReceipt).mockRejectedValueOnce(new Error("对象存储暂不可用"));
		render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter initialEntries={["/claims/claim-1"]}>
					<Routes><Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} /></Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);

		await user.click(await screen.findByRole("button", { name: "删除附件" }));
		await user.click(screen.getByRole("button", { name: "确认删除" }));
		const dialog = await screen.findByRole("alertdialog", { name: "删除附件" });
		expect(within(dialog).getByRole("alert")).toHaveTextContent("对象存储暂不可用");
		expect(within(dialog).getByRole("button", { name: "确认删除" })).toBeEnabled();
	});

	it("shows recognized receipt metadata and the immutable claim number", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { reimbursementApi } = await import("../../api/client");
		vi.mocked(reimbursementApi.getClaim).mockResolvedValueOnce({
			id: "claim-2", claimNumber: "BX20261008-0001", status: "DRAFT", version: 1, purpose: "上海客户拜访", expenseCategory: null, participants: [], projectCode: null,
			receiptCount: 1, recognizedReceiptCount: 1, totalAmountCent: 10155, missingAmountReceiptCount: 0,
			requestedAmountCent: 10155, currency: "CNY", requestedAmountSource: "OCR_SUGGESTED", remark: null,
			createdAt: "2026-10-08T08:00:00.000Z", updatedAt: "2026-10-08T08:00:00.000Z",
		});
		vi.mocked(reimbursementApi.listReceipts).mockResolvedValueOnce({
			items: [{ id: "receipt-2", claimId: "claim-2", filename: "hotel.png", status: "EXTRACTED", invoiceNumber: "26317000001513684420", invoiceDate: "2026-05-01", totalAmountCent: 10155, sellerName: "上海象鲜网络科技有限公司", ocrConfidence: 0.96, updatedAt: "2026-10-08T08:00:00.000Z" }],
		});
		const { container } = render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter initialEntries={["/claims/claim-2"]}>
					<Routes><Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} /></Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const page = within(container);

		expect(await page.findByText("BX20261008-0001")).toBeVisible();
		expect(page.getByText("发票号码")).toBeVisible();
		expect(page.getByText("26317000001513684420")).toBeVisible();
		expect(page.getByText("开票日期")).toBeVisible();
		expect(page.getByText("2026-05-01")).toBeVisible();
		expect(page.getByText("价税合计")).toBeVisible();
		expect(page.getAllByText("￥101.55")).toHaveLength(2);
		expect(page.getByText("上海象鲜网络科技有限公司")).toBeVisible();
		expect(page.getByRole("heading", { name: "申请报销信息" })).toBeVisible();
	});
});
