import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaimListPage } from "./claims-list-page";
import { reimbursementApi } from "../api/client";

afterEach(() => cleanup());

vi.mock("../api/client", () => ({
  reimbursementApi: {
    searchClaims: vi.fn().mockResolvedValue({
      items: [
        {
          id: "claim-1",
			claimNumber: "BX20261007-0001",
          status: "DRAFT",
          version: 1,
          purpose: "杭州客户拜访",
          expenseCategory: null,
          participants: [],
          projectCode: null,
			receiptCount: 3,
			recognizedReceiptCount: 2,
			totalAmountCent: 20397,
			missingAmountReceiptCount: 1,
          createdAt: "2026-10-07T08:00:00.000Z",
          updatedAt: "2026-10-07T08:00:00.000Z",
        },
      ],
      totalCount: 1,
      nextCursor: null,
    }),
  },
}));

describe("ClaimListPage", () => {
  it("shows the employee's drafts and links to an unpersisted new claim form", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ClaimListPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("杭州客户拜访")).toBeVisible();
		expect(screen.getByText("BX20261007-0001")).toBeVisible();
		expect(screen.getByText("已识别金额 ￥203.97 · 另有 1 份待补充")).toBeVisible();
		expect(screen.getByText("票据 3 份，已识别 2 份")).toBeVisible();
		const create = screen.getByRole("link", { name: "新建报销单" });
		expect(create).toHaveAttribute("href", "/claims/new");
    expect(screen.getByText("共 1 条匹配单据")).toBeVisible();
  });

  it("applies owner-scoped filters and appends the next cursor page without losing the first page", async () => {
    const search = vi.mocked(reimbursementApi.searchClaims);
    search.mockReset();
    search.mockResolvedValueOnce({ items: [{ id: "claim-1", claimNumber: "BX20261007-0001", status: "DRAFT", version: 1, purpose: "杭州客户拜访", receiptCount: 0, recognizedReceiptCount: 0, totalAmountCent: null, missingAmountReceiptCount: 0, createdAt: "2026-10-07T08:00:00Z", updatedAt: "2026-10-07T08:00:00Z" } as never], totalCount: 101, nextCursor: "next-cursor" });
    search.mockResolvedValueOnce({ items: [{ id: "claim-101", claimNumber: "BX20261007-0101", status: "DRAFT", version: 1, purpose: "旧单据", receiptCount: 0, recognizedReceiptCount: 0, totalAmountCent: null, missingAmountReceiptCount: 0, createdAt: "2026-10-07T08:00:00Z", updatedAt: "2026-10-07T08:00:00Z" } as never], totalCount: 101, nextCursor: null });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><ClaimListPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText("杭州客户拜访")).toBeVisible();
    expect(screen.getByText("共 101 条匹配单据")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "加载更多报销单" }));
    expect(await screen.findByText("旧单据")).toBeVisible();
    expect(screen.getByText("杭州客户拜访")).toBeVisible();
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next-cursor" }));
    expect(screen.queryByRole("button", { name: "加载更多报销单" })).not.toBeInTheDocument();
  });

  it("converts entered yuan bounds to cents and keeps invalid ranges out of Go requests", async () => {
    const search = vi.mocked(reimbursementApi.searchClaims);
    search.mockReset();
    search.mockResolvedValue({ items: [], totalCount: 0, nextCursor: null });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><ClaimListPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText("共 0 条匹配单据");
    await userEvent.selectOptions(screen.getByLabelText("状态"), "DRAFT");
    await userEvent.type(screen.getByLabelText("事由关键词"), "客户拜访");
    await userEvent.type(screen.getByLabelText("申请金额下限（元）"), "100.50");
    await userEvent.type(screen.getByLabelText("申请金额上限（元）"), "500");
    await userEvent.click(screen.getByRole("button", { name: "筛选单据" }));
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ status: "DRAFT", purposeContains: "客户拜访", minRequestedAmountCent: 10050, maxRequestedAmountCent: 50000, limit: 20 }));
    const called = search.mock.calls.length;
    await userEvent.clear(screen.getByLabelText("申请金额下限（元）"));
    await userEvent.type(screen.getByLabelText("申请金额下限（元）"), "600");
    await userEvent.click(screen.getByRole("button", { name: "筛选单据" }));
    expect(screen.getByRole("alert")).toHaveTextContent("金额范围");
    expect(search).toHaveBeenCalledTimes(called);
  });
});
