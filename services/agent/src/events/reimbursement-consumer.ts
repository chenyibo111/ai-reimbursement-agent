import type { ReimbursementPort } from "../ports/reimbursement-port";

type ReceiptEvent = { event_id: string; event_type: string; aggregate_id: string; payload: { claimId?: string; employeeId?: string; conversationId?: string } };

export function createReimbursementEventConsumer(deps: {
  port: ReimbursementPort;
  wasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  notify(input: { claimId: string; conversationId: string; workbench: unknown }): Promise<void>;
}) {
  return {
    async handle(event: ReceiptEvent) {
      if (event.event_type !== "ReceiptExtractionCompleted" || await deps.wasProcessed(event.event_id)) return;
      const claimId = event.payload.claimId;
      const actorEmployeeId = event.payload.employeeId;
      const conversationId = event.payload.conversationId;
      if (!claimId || !actorEmployeeId || !conversationId) return;
      const workbench = await deps.port.getClaimWorkbench({
        actorEmployeeId,
        channel: "FEISHU",
        conversationId,
        toolCallId: `event:${event.event_id}:get_claim_workbench`,
        idempotencyKey: `event:${event.event_id}:get_claim_workbench`,
        claimId,
      });
      await deps.notify({ claimId, conversationId, workbench });
      await deps.markProcessed(event.event_id);
    },
  };
}
