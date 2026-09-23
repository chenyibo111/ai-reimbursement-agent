import { expect, it } from "vitest";

import { requestSubmission } from "@/src/application/request-submission";
import { submitClaim } from "@/src/application/submit-claim";

it("rejects a stale confirmation token", async () => {
  const claims = {
    current: { id: "claim-1", employeeId: "employee-1", version: 2, purpose: "客户拜访", totalAmountCents: 38600, receiptCount: 1 },
    get: async () => claims.current,
  };
  const deps = {
    claims,
    validate: async () => [],
    tokens: { create: (input: { claimId: string; version: number }) => `token:${input.claimId}:${input.version}`, read: (token: string) => ({ claimId: token.split(":")[1], version: Number(token.split(":")[2]) }) },
    submissions: { create: async () => ({ submissionNumber: "RB20260001" }) },
  };
  const preview = await requestSubmission({ actorId: "employee-1", claimId: "claim-1" }, deps);
  claims.current = { ...claims.current, version: 3, purpose: "已修改" };

  await expect(submitClaim({ actorId: "employee-1", claimId: "claim-1", confirmationToken: preview.token }, deps)).rejects.toThrow("confirmation is stale");
});
