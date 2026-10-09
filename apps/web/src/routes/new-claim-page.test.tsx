import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewClaimPage } from "./new-claim-page";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock,
}));

vi.mock("../api/client", () => ({
  reimbursementApi: {
    createClaim: vi.fn().mockResolvedValue({ id: "claim-new", claimNumber: "BX20261009-0001", status: "DRAFT", version: 1, purpose: "客户午餐招待" }),
    updateClaim: vi.fn().mockResolvedValue({ id: "claim-new", claimNumber: "BX20261009-0001", status: "DRAFT", version: 2, purpose: "客户午餐招待" }),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewClaimPage", () => {
  it("keeps a new claim local until the employee explicitly saves the draft", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { reimbursementApi } = await import("../api/client");
    render(<QueryClientProvider client={queryClient}><MemoryRouter><NewClaimPage /></MemoryRouter></QueryClientProvider>);

    expect(screen.getByLabelText(/报销事由/)).toBeVisible();
    expect(screen.getByLabelText("申请报销总额")).toBeVisible();
    expect(reimbursementApi.createClaim).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/报销事由/), "客户午餐招待");
    await user.type(screen.getByLabelText("申请报销总额"), "128.50");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));

    await waitFor(() => expect(reimbursementApi.createClaim).toHaveBeenCalledWith("客户午餐招待"));
    await waitFor(() => expect(reimbursementApi.updateClaim).toHaveBeenCalledWith("claim-new", expect.objectContaining({ version: 1, requestedAmountCent: 12850 })));
  });

  it("opens the created draft if saving the remaining fields fails", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { reimbursementApi } = await import("../api/client");
    vi.mocked(reimbursementApi.createClaim).mockResolvedValueOnce({ id: "claim-created", claimNumber: "BX20261009-0002", status: "DRAFT", version: 1, purpose: "" } as never);
    vi.mocked(reimbursementApi.updateClaim).mockRejectedValueOnce(new Error("network failed"));
    render(<QueryClientProvider client={queryClient}><MemoryRouter><NewClaimPage /></MemoryRouter></QueryClientProvider>);

    await user.click(screen.getByRole("button", { name: "保存草稿" }));

    await waitFor(() => expect(reimbursementApi.updateClaim).toHaveBeenCalled());
    expect(navigateMock).toHaveBeenCalledWith("/claims/claim-created", {
      replace: true,
      state: { notice: "草稿已创建，但申请信息未完全保存。请补充后重新保存。" },
    });
  });
});
