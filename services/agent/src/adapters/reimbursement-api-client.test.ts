import { expect, it, vi } from "vitest";

import { ReimbursementApiClient, ReimbursementApiHttpError } from "./reimbursement-api-client";

it("sends a versioned receipt deletion and accepts a 204 response", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: "conversation-1", toolCallId: "delete-1", idempotencyKey: "delete-1" };
  await expect(client.deleteOwnedReceipt({ ...context, claimId: "claim-1", receiptId: "receipt-2", expectedClaimVersion: 3 })).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toBe("http://go.test/api/v1/claims/claim-1/receipts/receipt-2?expectedClaimVersion=3");
  expect(fetcher.mock.calls[0][1]?.method).toBe("DELETE");
});

it("preserves Go's safe error code and HTTP status for state-machine decisions", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "VERSION_CONFLICT", message: "claim changed", requestId: "req-1" }, { status: 409 }));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: "conversation-1", toolCallId: "submit-1", idempotencyKey: "submit-1" };
  await expect(client.submitClaim({ ...context, claimId: "claim-1", confirmationToken: "old-token" })).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", message: "claim changed" } satisfies Partial<ReimbursementApiHttpError>);
});

it("passes actor-scoped number lookup and only approved fields to Go", async () => {
  const claim = { id: "claim-1", claimNumber: "BX20261009-0026", version: 2, status: "DRAFT", purpose: "old", expenseCategory: "", participants: [], projectCode: "", totalAmountCent: null, currency: "CNY" };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [claim] })).mockResolvedValueOnce(Response.json(claim));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: "conversation-1", toolCallId: "turn-1", idempotencyKey: "turn-1" };
  await expect(client.findOwnedClaimByNumber({ ...context, claimNumber: "BX20261009-0026" })).resolves.toEqual(claim);
  await client.updateClaimFields({ ...context, claimId: "claim-1", version: 2, fields: { participants: ["张三"] } });
  expect(fetcher.mock.calls[0][0]).toBe("http://go.test/api/v1/claims?claimNumber=BX20261009-0026");
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ version: 2, participants: ["张三"] });
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "X-Agent-Service-Key": "key" });
});

it("accepts a new Go draft whose unset participants are JSON null", async () => {
  const draft = { id: "claim-1", claimNumber: "BX20261009-0026", version: 1, status: "DRAFT", purpose: "", expenseCategory: "", participants: null, projectCode: "", totalAmountCent: null, currency: "CNY" };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [draft] })).mockResolvedValueOnce(Response.json({ items: [draft] }));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "WEB" as const, conversationId: "conversation-1", toolCallId: "read-1", idempotencyKey: "read-1" };
  await expect(client.listOwnedClaims({ ...context, limit: 5 })).resolves.toMatchObject([{ participants: [] }]);
  await expect(client.findOwnedClaimByNumber({ ...context, claimNumber: draft.claimNumber })).resolves.toMatchObject({ participants: [] });
});

it("encodes an owned search and preserves unset requested amount", async () => {
  const claim = { id: "claim-1", claimNumber: "BX20261026-0001", version: 1, status: "DRAFT", purpose: "交通", expenseCategory: "交通费", participants: [], projectCode: "", totalAmountCent: null, requestedAmountCent: null, currency: "CNY" };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [claim], totalCount: 12, nextCursor: "abc" }));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: "conversation-1", toolCallId: "search-1", idempotencyKey: "search-1" };
  const page = await client.searchOwnedClaims({ ...context, query: { status: "DRAFT", purposeContains: "交通&拜访", sort: "amount_desc", limit: 10, cursor: "a+b" } });
  expect(page).toMatchObject({ totalCount: 12, nextCursor: "abc", items: [{ requestedAmountCent: null }] });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.searchParams.get("purposeContains")).toBe("交通&拜访");
  expect(url.searchParams.get("cursor")).toBe("a+b");
  expect(url.searchParams.get("search")).toBe("true");
  expect(url.searchParams.has("ownerId")).toBe(false);
});

it("rejects malformed Go search pages", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [], totalCount: "12", nextCursor: null }));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "WEB" as const, conversationId: "conversation-1", toolCallId: "search-2", idempotencyKey: "search-2" };
  await expect(client.searchOwnedClaims({ ...context, query: { limit: 5 } })).rejects.toThrow("invalid owned claim search");
});
