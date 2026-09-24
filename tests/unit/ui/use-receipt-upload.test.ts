import { expect, it, vi } from "vitest";

import { uploadReceipt } from "@/src/ui/use-receipt-upload";

it("uses one upload then OCR sequence and keeps the original file name", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "receipt-1" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
  const onComplete = vi.fn();
  const file = new File(["invoice"], "客户发票.pdf", { type: "application/pdf" });

  await expect(uploadReceipt({ claimId: "claim-1", file, fetchImpl, onComplete })).resolves.toEqual({ status: "EXTRACTED", filename: "客户发票.pdf" });
  expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/claims/claim-1/receipts", expect.objectContaining({ method: "POST" }));
  expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/claims/claim-1/receipts/receipt-1/extract", { method: "POST" });
  expect(onComplete).toHaveBeenCalledOnce();
});

it("refreshes the workbench when storage succeeds but OCR fails", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "receipt-1" }), { status: 201 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "ocr failed" }), { status: 500 }));
  const onComplete = vi.fn();
  await expect(uploadReceipt({ claimId: "claim-1", file: new File(["invoice"], "failed.pdf", { type: "application/pdf" }), fetchImpl, onComplete })).resolves.toMatchObject({ status: "SAVED_UNEXTRACTED" });
  expect(onComplete).toHaveBeenCalledOnce();
});
