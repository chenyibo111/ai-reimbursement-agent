import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ClaimWorkbenchPage } from "../../routes/claim-workbench-page";

vi.mock("../../api/client", () => ({
  reimbursementApi: {
    getClaim: vi.fn().mockResolvedValue({
      id: "claim-1",
      status: "DRAFT",
      version: 1,
      purpose: "广州客户拜访",
      expenseCategory: null,
      participants: [],
      projectCode: null,
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
    expect(screen.getByRole("button", { name: "确认提交" })).toBeDisabled();
  });
});
