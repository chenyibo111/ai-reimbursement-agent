import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, within } from "@testing-library/react";
import { expect, it } from "vitest";

import type { Claim } from "../../api/generated/reimbursement";
import { ExpenseItemsPanel } from "./expense-items-panel";

it("shows recognized expense items as read-only evidence", () => {
	const claim = {
		id: "claim-1", claimNumber: "BX20261109-0001", status: "DRAFT", version: 3, itemizationMode: "ITEMIZED",
		purpose: "市内出行及餐饮费用", expenseCategory: null, participants: [], projectCode: null,
		receiptCount: 2, recognizedReceiptCount: 2, totalAmountCent: 9000, missingAmountReceiptCount: 0,
		requestedAmountCent: 9000, currency: "CNY", requestedAmountSource: "OCR_SUGGESTED", remark: null,
		createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
		expenseItems: [
			{ id: "taxi", claimId: "claim-1", receiptId: "taxi", receiptType: "TAXI", expenseCategory: "交通费", categorySource: "MODEL", purpose: "市内出行打车费", purposeSource: "MODEL", amountCent: 3800, amountSource: "OCR", projectCode: "", participants: [] },
			{ id: "dining", claimId: "claim-1", receiptId: "dining", receiptType: "DINING", expenseCategory: "餐饮费", categorySource: "MODEL", purpose: "餐饮费用", purposeSource: "MODEL", amountCent: 5200, amountSource: "OCR", projectCode: "", participants: [] },
		],
	} satisfies Claim;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { container } = render(<QueryClientProvider client={client}><ExpenseItemsPanel claim={claim} /></QueryClientProvider>);
	const panel = within(container);
	expect(panel.getByText(/打车/)).toBeVisible();
	expect(panel.getByText(/餐饮/)).toBeVisible();
	expect(panel.getByText("￥38.00")).toBeVisible();
	expect(panel.getByText("￥52.00")).toBeVisible();
	expect(panel.queryByRole("textbox")).toBeNull();
	expect(panel.queryByRole("button")).toBeNull();
	expect(panel.queryByText("市内出行打车费")).toBeNull();
});

it("explains an uncertain classification while keeping OCR amount visible", () => {
	const claim: Claim = {
		id: "claim-2", claimNumber: "BX20261109-0002", ownerId: "employee-1", status: "DRAFT", version: 2,
		itemizationMode: "ITEMIZED", purpose: "", expenseCategory: null, participants: [], projectCode: null,
		receiptCount: 1, recognizedReceiptCount: 1, totalAmountCent: 5200, missingAmountReceiptCount: 0,
		requestedAmountCent: 5200, currency: "CNY", requestedAmountSource: "OCR_SUGGESTED", remark: null,
		createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
		expenseItems: [{ id: "item-2", claimId: "claim-2", receiptId: "receipt-2", receiptType: "", classificationStatus: "FAILED", expenseCategory: "", categorySource: "", purpose: "", purposeSource: "", amountCent: 5200, amountSource: "OCR", projectCode: "", participants: [] }],
	};
	const client = new QueryClient();
	const { container } = render(<QueryClientProvider client={client}><ExpenseItemsPanel claim={claim} /></QueryClientProvider>);
	expect(within(container).getByText("AI 分类失败，请核对申请信息")).toBeVisible();
	expect(within(container).getByText("￥52.00")).toBeVisible();
});

it("opens an existing item whose participants were returned as null", () => {
	const claim = {
		id: "claim-null", status: "DRAFT", version: 2,
		expenseItems: [{ id: "item-null", receiptId: "receipt-null", receiptType: "TAXI", expenseCategory: "交通费", categorySource: "MODEL", purpose: "市内出行打车费", purposeSource: "MODEL", amountCent: 3800, amountSource: "OCR", projectCode: "", participants: null }],
	} as unknown as Claim;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { container } = render(<QueryClientProvider client={client}><ExpenseItemsPanel claim={claim} /></QueryClientProvider>);
	expect(within(container).getByText("￥38.00")).toBeVisible();
	expect(within(container).queryByRole("textbox")).toBeNull();
});
