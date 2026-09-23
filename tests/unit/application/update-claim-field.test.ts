import { expect, it } from "vitest";

import { updateClaimField } from "@/src/application/update-claim-field";

it("records USER_ENTERED when an employee confirms the purpose", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const updated = await updateClaimField(
    { actorId: "employee-1", claimId: "claim-1", field: "purpose", value: "客户午餐", expectedVersion: 2 },
    {
      claims: {
        getByIdOrThrow: async () => ({ id: "claim-1", employeeId: "employee-1", status: "DRAFT" as const, purpose: null, version: 2 }),
        updateDraft: async () => ({ id: "claim-1", employeeId: "employee-1", status: "DRAFT" as const, purpose: "客户午餐", version: 3 }),
      },
      audit: { append: async (event) => { events.push(event); } },
    },
  );

  expect(updated.fields.purpose).toEqual({ value: "客户午餐", source: "USER_ENTERED" });
  expect(events).toContainEqual(expect.objectContaining({ type: "CLAIM_FIELD_UPDATED", payload: expect.objectContaining({ field: "purpose", source: "USER_ENTERED" }) }));
});
