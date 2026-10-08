import { describe, expect, it, vi } from "vitest";

import { ReimbursementApiClient } from "../adapters/reimbursement-api-client";

describe("ReimbursementApiClient", () => {
  it("passes actor, channel, conversation, tool call, and idempotency metadata to Go", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "claim-1", version: 1, status: "DRAFT", purpose: "客户拜访",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const client = new ReimbursementApiClient({
      baseUrl: "http://reimbursement-api:8080",
      serviceKey: "agent-service-key",
      signingSecret: "test-signing-secret",
      fetcher,
      now: () => new Date("2026-10-07T10:00:00.000Z"),
      randomId: () => "jwt-id-1",
    });

    await client.createClaimDraft({
      actorEmployeeId: "employee-1",
      actorRole: "EMPLOYEE",
      channel: "FEISHU",
      conversationId: "conversation-1",
      toolCallId: "tool-call-1",
      idempotencyKey: "idempotency-1",
      purpose: "客户拜访",
    });

    expect(fetcher).toHaveBeenCalledWith("http://reimbursement-api:8080/api/v1/claims", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "X-Agent-Service-Key": "agent-service-key",
        "Idempotency-Key": "idempotency-1",
      }),
    }));
    const authorization = new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")!;
    const claims = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString("utf8"));
    expect(claims).toMatchObject({ sub: "employee-1", role: "EMPLOYEE", aud: "reimbursement-api", channel: "agent", source_channel: "FEISHU", conversation_id: "conversation-1", tool_call_id: "tool-call-1", jti: "jwt-id-1", iat: 1_791_367_200 });
  });
});
