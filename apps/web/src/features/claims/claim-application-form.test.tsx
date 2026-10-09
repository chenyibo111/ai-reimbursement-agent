import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reimbursementApi } from "../../api/client";
import type { Claim } from "../../api/generated/reimbursement";
import { ClaimApplicationForm, parseCNYAmountToCent } from "./claim-application-form";

vi.mock("../../api/client", () => ({
  reimbursementApi: {
    updateClaim: vi.fn(),
  },
}));

const manualClaim: Claim = {
  id: "claim-1", claimNumber: "BX20261008-0001", ownerId: "employee-1", status: "DRAFT", version: 3,
  purpose: "客户拜访", expenseCategory: null, participants: [], projectCode: null,
  receiptCount: 2, recognizedReceiptCount: 2, totalAmountCent: 10155, missingAmountReceiptCount: 0,
  requestedAmountCent: 9999, currency: "CNY", requestedAmountSource: "MANUAL", remark: "原备注",
  createdAt: "2026-10-08T08:00:00.000Z", updatedAt: "2026-10-08T08:00:00.000Z",
};

function renderForm(claim: Claim = manualClaim) {
	vi.mocked(reimbursementApi.updateClaim).mockResolvedValue(claim);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ClaimApplicationForm claim={claim} recognizedAmountCent={claim.totalAmountCent} /></QueryClientProvider>);
}

describe("ClaimApplicationForm", () => {
	afterEach(cleanup);
	beforeEach(() => vi.clearAllMocks());

  it("converts decimal CNY text to exact cents without floating point", () => {
    expect(parseCNYAmountToCent("101.55")).toEqual({ cents: 10155 });
    expect(parseCNYAmountToCent("0.01")).toEqual({ cents: 1 });
    expect(parseCNYAmountToCent("1.234").error).toContain("两位");
    expect(parseCNYAmountToCent("1e2").error).toContain("数字");
  });

  it("uses a generic amount hint and explains when recognized receipts have no amount", () => {
    const claim = { ...manualClaim, requestedAmountCent: null, requestedAmountSource: "OCR_SUGGESTED" as const, totalAmountCent: null, recognizedReceiptCount: 1 };
    const { container } = renderForm(claim);
    const form = within(container);

    expect(form.getByLabelText("申请报销总额")).toHaveAttribute("placeholder", "请输入金额");
    expect(form.getByText("已识别票据尚未提取金额，请手工补充申请报销总额。")).toBeVisible();
  });

  it("saves the report purpose together with the other application fields", async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    const form = within(container);

    const purpose = form.getByLabelText(/报销事由/);
    await user.clear(purpose);
    await user.type(purpose, "客户午餐招待");
    await user.click(form.getByRole("button", { name: "保存草稿" }));

    const { reimbursementApi } = await import("../../api/client");
    expect(reimbursementApi.updateClaim).toHaveBeenCalledWith("claim-1", expect.objectContaining({
      version: 3,
      purpose: "客户午餐招待",
    }));
  });

  it("shows OCR difference and sends only the explicit restore action", async () => {
    const user = userEvent.setup();
		const { container } = renderForm();
		const form = within(container);

		expect(form.getByText("与识别票据合计相差 ￥1.56")).toBeVisible();
		await user.click(form.getByRole("button", { name: "恢复 OCR 建议金额" }));

    const { reimbursementApi } = await import("../../api/client");
    expect(reimbursementApi.updateClaim).toHaveBeenCalledWith("claim-1", { version: 3, useOcrSuggestedAmount: true });
  });

	it("preserves the typed amount and remark when the server rejects a save", async () => {
		const user = userEvent.setup();
		const { container } = renderForm();
		const form = within(container);
		vi.mocked(reimbursementApi.updateClaim).mockRejectedValueOnce(new Error("报销单已变化，请重新确认"));

		const amount = form.getByLabelText("申请报销总额");
		await user.clear(amount);
		await user.type(amount, "101.55");
		await user.clear(form.getByLabelText(/备注/));
		await user.type(form.getByLabelText(/备注/), "客户拜访交通费");
		await user.click(form.getByRole("button", { name: "保存草稿" }));

		expect(await form.findByText("报销单已变化，请重新确认")).toBeVisible();
		expect(amount).toHaveValue("101.55");
		expect(form.getByLabelText(/备注/)).toHaveValue("客户拜访交通费");
	});
});
