import { expect, it, vi } from "vitest";

import { resolveAgentProposal } from "@/src/application/resolve-agent-proposal";

it("delegates proposal resolution to the transactional repository boundary", async () => {
  const resolve = vi.fn().mockResolvedValue({ proposal: { id: "proposal-1", status: "ACCEPTED" }, version: 3 });
  await expect(resolveAgentProposal({ actorId: "employee-1", claimId: "claim-1", proposalId: "proposal-1", action: "ACCEPT", expectedVersion: 2 }, { resolve })).resolves.toEqual({ proposal: { id: "proposal-1", status: "ACCEPTED" }, version: 3 });
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ actorId: "employee-1", action: "ACCEPT", expectedVersion: 2 }));
});
