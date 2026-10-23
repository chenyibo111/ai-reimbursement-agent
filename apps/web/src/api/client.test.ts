import { describe, expect, it, vi } from "vitest";

import { createReimbursementApi } from "./client";

describe("createReimbursementApi", () => {
  it("refreshes once after a mutation 401 and reuses the same idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "claim-1", version: 1, status: "DRAFT", purpose: "客户拜访" }), { status: 201, headers: { "Content-Type": "application/json" } }));
    let accessToken = "token-1";
    const refreshAccessToken = vi.fn(async () => { accessToken = "token-2"; return accessToken; });
    const api = createReimbursementApi({ getAccessToken: () => accessToken, refreshAccessToken }, { fetcher, randomId: () => "stable-key" });

    await expect(api.createClaim("客户拜访")).resolves.toMatchObject({ id: "claim-1" });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetcher.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1][1]?.headers);
    expect(firstHeaders.get("Idempotency-Key")).toBe("stable-key");
    expect(secondHeaders.get("Idempotency-Key")).toBe("stable-key");
    expect(secondHeaders.get("Authorization")).toBe("Bearer token-2");
  });

  it("does not retry after a second 401", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "UNAUTHENTICATED", message: "请先登录" }), { status: 401, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "UNAUTHENTICATED", message: "请先登录" }), { status: 401, headers: { "Content-Type": "application/json" } }));
    let accessToken = "token-1";
    const refreshAccessToken = vi.fn(async () => { accessToken = "token-2"; return accessToken; });
    const api = createReimbursementApi({ getAccessToken: () => accessToken, refreshAccessToken }, { fetcher, randomId: () => "stable-key" });

    await expect(api.createClaim("客户拜访")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sends an idempotent PATCH for claim application fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "claim-1", requestedAmountCent: 10155, currency: "CNY", requestedAmountSource: "MANUAL", remark: "客户拜访交通费" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createReimbursementApi({ getAccessToken: () => "token-1", refreshAccessToken: async () => "token-1" }, { fetcher, randomId: () => "patch-key" });

    await api.updateClaim("claim-1", { version: 3, requestedAmountCent: 10155, currency: "CNY", remark: "客户拜访交通费" });

    expect(fetcher).toHaveBeenCalledWith("/api/v1/claims/claim-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ version: 3, requestedAmountCent: 10155, currency: "CNY", remark: "客户拜访交通费" }) }));
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("patch-key");
  });

  it("uses the finance review endpoints with versioned claim and correction payloads", async () => {
    const review = { id: "review-1", claimId: "claim-1", receiptId: "receipt-1", kind: "RECEIPT_OCR", reasonCode: "OCR_LOW_CONFIDENCE", status: "OPEN", assignedTo: "", version: 2, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [review] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...review, status: "CLAIMED", version: 3 }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...review, status: "RESOLVED", version: 4 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createReimbursementApi({ getAccessToken: () => "token-1", refreshAccessToken: async () => "token-1" }, { fetcher, randomId: () => "review-key" });

    await api.listReviews();
    await api.getReview("review-1");
    await api.claimReview("review-1", 2);
    await api.resolveReview("review-1", { expectedVersion: 3, action: "CORRECT_FIELDS", resolution: "已核对原票", invoiceNumber: "INV-2026-1", invoiceDate: "2026-10-14", totalAmountCent: 12345, sellerName: "示例商户" });

    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method ?? "GET", options?.body])).toEqual([
      ["/api/v1/admin/reviews", "GET", undefined],
      ["/api/v1/admin/reviews/review-1", "GET", undefined],
      ["/api/v1/admin/reviews/review-1/claim", "POST", JSON.stringify({ expectedVersion: 2 })],
      ["/api/v1/admin/reviews/review-1/resolve", "POST", JSON.stringify({ expectedVersion: 3, action: "CORRECT_FIELDS", resolution: "已核对原票", invoiceNumber: "INV-2026-1", invoiceDate: "2026-10-14", totalAmountCent: 12345, sellerName: "示例商户" })],
    ]);
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get("Idempotency-Key")).toBe("review-key");
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("gets a finance-only receipt preview without using an idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ url: "https://files.example/receipts/receipt-1?signature=safe", expiresAt: "2026-10-23T12:10:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createReimbursementApi({ getAccessToken: () => "token-1", refreshAccessToken: async () => "token-1" }, { fetcher, randomId: () => "preview-key" });

    await expect(api.getReviewReceiptPreview("review-1")).resolves.toMatchObject({ url: "https://files.example/receipts/receipt-1?signature=safe" });

    expect(fetcher.mock.calls[0][0]).toBe("/api/v1/admin/reviews/review-1/receipt-preview");
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer token-1");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBeNull();
  });
});
