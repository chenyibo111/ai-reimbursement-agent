import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ClaimListPage } from "./claims-list-page";

vi.mock("../api/client", () => ({
  reimbursementApi: {
    listClaims: vi.fn().mockResolvedValue({
      items: [
        {
          id: "claim-1",
          status: "DRAFT",
          version: 1,
          purpose: "杭州客户拜访",
          expenseCategory: null,
          participants: [],
          projectCode: null,
          createdAt: "2026-10-07T08:00:00.000Z",
          updatedAt: "2026-10-07T08:00:00.000Z",
        },
      ],
    }),
  },
}));

describe("ClaimListPage", () => {
  it("shows the employee's drafts and opens the accessible create form", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ClaimListPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("杭州客户拜访")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "新建报销草稿" }));

    expect(screen.getByRole("heading", { name: "新建报销草稿" })).toBeVisible();
    expect(screen.getByLabelText("报销事由")).toBeVisible();
  });
});
