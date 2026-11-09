import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { reimbursementApi } from "../../api/client";
import type { Claim } from "../../api/generated/reimbursement";
import { ExpenseItemsPanel } from "./expense-items-panel";

vi.mock("../../api/client", () => ({ reimbursementApi: { updateExpenseItem: vi.fn() } }));

it("edits the taxi category without changing the dining item", async () => {
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
	vi.mocked(reimbursementApi.updateExpenseItem).mockResolvedValue(claim);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(<QueryClientProvider client={client}><ExpenseItemsPanel claim={claim} /></QueryClientProvider>);
	const user = userEvent.setup();
	await user.clear(screen.getByLabelText("第 1 条费用类别"));
	await user.type(screen.getByLabelText("第 1 条费用类别"), "市内交通费");
	view.rerender(<QueryClientProvider client={client}><ExpenseItemsPanel claim={{ ...claim, expenseItems: claim.expenseItems.map((item) => ({ ...item })) }} /></QueryClientProvider>);
	expect(screen.getByLabelText("第 1 条费用类别")).toHaveValue("市内交通费");
	await user.click(screen.getByRole("button", { name: "保存第 1 条明细" }));
	expect(reimbursementApi.updateExpenseItem).toHaveBeenCalledWith("claim-1", "taxi", expect.objectContaining({ version: 3, expenseCategory: "市内交通费" }));
	expect(screen.getByLabelText("第 2 条费用类别")).toHaveValue("餐饮费");
});
