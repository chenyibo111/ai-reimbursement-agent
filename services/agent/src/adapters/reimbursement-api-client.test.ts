import { expect, it, vi } from "vitest";

import { ReimbursementApiClient, ReimbursementApiHttpError } from "./reimbursement-api-client";

it("preserves Go's safe error code and HTTP status for state-machine decisions", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "VERSION_CONFLICT", message: "claim changed", requestId: "req-1" }, { status: 409 }));
  const client = new ReimbursementApiClient({ baseUrl: "http://go.test", serviceKey: "key", signingSecret: "secret", fetcher });
  const context = { actorEmployeeId: "employee-1", actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: "conversation-1", toolCallId: "submit-1", idempotencyKey: "submit-1" };
  await expect(client.submitClaim({ ...context, claimId: "claim-1", confirmationToken: "old-token" })).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", message: "claim changed" } satisfies Partial<ReimbursementApiHttpError>);
});
