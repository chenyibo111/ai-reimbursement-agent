import { expect, it, vi } from "vitest";

import { PrismaAgentProcessedEventRepository } from "@/src/infrastructure/prisma/agent-processed-event-repository";

it("keys consumed reimbursement events by event and consumer", async () => {
  const findUnique = vi.fn().mockResolvedValue(null);
  const create = vi.fn().mockResolvedValue({});
  const repository = new PrismaAgentProcessedEventRepository({
    agentProcessedEvent: { findUnique, create },
  } as never, "feishu-reimbursement-notifications-v1");

  await expect(repository.wasProcessed("event-1")).resolves.toBe(false);
  await repository.markProcessed("event-1");

  expect(findUnique).toHaveBeenCalledWith({
    where: { eventId_consumerName: { eventId: "event-1", consumerName: "feishu-reimbursement-notifications-v1" } },
    select: { eventId: true },
  });
  expect(create).toHaveBeenCalledWith({
    data: { eventId: "event-1", consumerName: "feishu-reimbursement-notifications-v1" },
  });
});
