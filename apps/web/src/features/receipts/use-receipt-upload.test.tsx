import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { reimbursementApi } from "../../api/client";
import { claimKeys } from "../claims/use-claim";
import { useReceiptUpload } from "./use-receipt-upload";

vi.mock("../../api/client", () => ({ reimbursementApi: {
  createUploadSession: vi.fn().mockResolvedValue({ receiptId: "receipt-1", uploadUrl: "https://storage.example/upload" }),
  finalizeReceipt: vi.fn().mockResolvedValue({ receiptId: "receipt-1", status: "READY_FOR_OCR" }),
} }));

afterEach(() => vi.unstubAllGlobals());

it("refreshes the claim version and validation after a receipt upload", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useReceiptUpload("claim-1"), { wrapper });
  await act(async () => { await result.current.mutateAsync(new File(["a"], "a.png", { type: "image/png" })); });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(reimbursementApi.finalizeReceipt).toHaveBeenCalledWith("claim-1", "receipt-1");
  expect(invalidate).toHaveBeenCalledWith({ queryKey: claimKeys.all });
});
