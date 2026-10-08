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
});
