import type { ReimbursementPort } from "../ports/reimbursement-port";

type ReceiptEvent = { event_id: string; event_type: string; aggregate_id: string; payload: { claimId?: string } };

export function createReimbursementEventConsumer(deps: {
  port: ReimbursementPort;
  wasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  findNotificationTarget(claimId: string): Promise<{ employeeId: string; conversationId: string; chatId: string } | null>;
  notify(input: { eventId: string; claimId: string; conversationId: string; chatId: string; workbench: unknown }): Promise<void>;
}) {
  return {
    async handle(event: ReceiptEvent) {
      if (event.event_type !== "ReceiptExtractionCompleted" || await deps.wasProcessed(event.event_id)) return;
      const claimId = event.payload.claimId;
      if (!claimId) return;
      const target = await deps.findNotificationTarget(claimId);
      if (!target) return;
      const workbench = await deps.port.getClaimWorkbench({
        actorEmployeeId: target.employeeId,
        actorRole: "EMPLOYEE",
        channel: "FEISHU",
        conversationId: target.conversationId,
        toolCallId: `event:${event.event_id}:get_claim_workbench`,
        idempotencyKey: `event:${event.event_id}:get_claim_workbench`,
        claimId,
      });
      await deps.notify({ eventId: event.event_id, claimId, conversationId: target.conversationId, chatId: target.chatId, workbench });
      await deps.markProcessed(event.event_id);
    },
  };
}
