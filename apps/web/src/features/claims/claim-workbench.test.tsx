import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ClaimWorkbenchPage } from "../../routes/claim-workbench-page";

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
    getValidation: vi.fn().mockResolvedValue({
      claimId: "claim-1",
      claimVersion: 1,
      policyVersion: "baseline-v1",
      issues: [{ code: "RECEIPT_PROCESSING", severity: "BLOCKING", message: "票据仍在识别中" }],
    }),
  },
}));

describe("ClaimWorkbenchPage", () => {
  it("shows OCR-pending receipt and blocks submit until validation passes", async () => {
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
    expect(screen.getByRole("button", { name: "确认提交" })).toBeDisabled();
  });

	it("shows recognized receipt metadata and the immutable claim number", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { reimbursementApi } = await import("../../api/client");
		vi.mocked(reimbursementApi.getClaim).mockResolvedValueOnce({
			id: "claim-2", claimNumber: "BX20261008-0001", status: "DRAFT", version: 1, purpose: "上海客户拜访", expenseCategory: null, participants: [], projectCode: null,
			receiptCount: 1, recognizedReceiptCount: 1, totalAmountCent: 10155, missingAmountReceiptCount: 0,
			createdAt: "2026-10-08T08:00:00.000Z", updatedAt: "2026-10-08T08:00:00.000Z",
		});
		vi.mocked(reimbursementApi.listReceipts).mockResolvedValueOnce({
			items: [{ id: "receipt-2", claimId: "claim-2", filename: "hotel.png", status: "EXTRACTED", invoiceNumber: "26317000001513684420", invoiceDate: "2026-05-01", totalAmountCent: 10155, sellerName: "上海象鲜网络科技有限公司", ocrConfidence: 0.96, updatedAt: "2026-10-08T08:00:00.000Z" }],
		});
		render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter initialEntries={["/claims/claim-2"]}>
					<Routes><Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} /></Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(await screen.findByText("BX20261008-0001")).toBeVisible();
		expect(screen.getByText("发票号码")).toBeVisible();
		expect(screen.getByText("26317000001513684420")).toBeVisible();
		expect(screen.getByText("开票日期")).toBeVisible();
		expect(screen.getByText("2026-05-01")).toBeVisible();
		expect(screen.getByText("价税合计")).toBeVisible();
		expect(screen.getByText("￥101.55")).toBeVisible();
		expect(screen.getByText("上海象鲜网络科技有限公司")).toBeVisible();
	});
});
