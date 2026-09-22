import { expect, it } from "vitest";

import { createClaimDraft } from "@/src/application/create-claim-draft";

it("creates a DRAFT owned by the authenticated employee and records an event", async () => {
  const events: Array<{ type: string; actorId: string; claimId: string; payload: Record<string, unknown> }> = [];
  const result = await createClaimDraft(
    { actorId: "employee-1", purpose: "客户拜访" },
    {
      claims: {
        create: async (input) => ({
          id: "claim-1",
          employeeId: input.employeeId,
          purpose: input.purpose,
          status: input.status,
          version: 0,
        }),
      },
      audit: {
        append: async (event) => {
          events.push(event);
        },
      },
    },
  );

  expect(result).toMatchObject({ employeeId: "employee-1", purpose: "客户拜访", status: "DRAFT" });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "CLAIM_CREATED", actorId: "employee-1", claimId: "claim-1" }),
  );
});
