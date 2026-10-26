import { expect, it, vi } from "vitest";

import { ReimbursementApiClient, ReimbursementApiHttpError } from "./reimbursement-api-client";

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
