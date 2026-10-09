import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ClaimListPage } from "./claims-list-page";

vi.mock("../api/client", () => ({
  reimbursementApi: {
    listClaims: vi.fn().mockResolvedValue({
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
  });
});
