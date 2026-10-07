import { expect, it, vi } from "vitest";

import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";

it("stores a Go reimbursement claim ID as an opaque scalar reference", async () => {
  const update = vi.fn().mockResolvedValue({ id: "intake-1", claimId: "go-claim-1" });
  const repository = new AgentConversationRepository({
    reimbursementIntake: { update },
  } as never);

  await repository.updateIntake({ id: "intake-1", claimId: "go-claim-1" });

  expect(update).toHaveBeenCalledWith({
    where: { id: "intake-1" },
    data: expect.objectContaining({ claimId: "go-claim-1" }),
  });
  expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("claim");
});
