import type { ClaimProgressSnapshot, ReimbursementPort } from "../ports/reimbursement-port";

type ReceiptEvent = { event_id: string; event_type: string; aggregate_id: string; payload: { claimId?: string } };

export function createReimbursementEventConsumer(deps: {
  port: ReimbursementPort;
  acceptedEventTypes?: readonly string[];
  wasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  findNotificationTarget(claimId: string): Promise<{ employeeId: string; conversationId: string; chatId: string } | null>;
  notify(input: { eventId: string; eventType: string; claimId: string; receiptId?: string; conversationId: string; chatId: string; workbench?: unknown; progress?: ClaimProgressSnapshot }): Promise<void>;
}) {
  return {
    async handle(event: ReceiptEvent) {
      if (deps.acceptedEventTypes && !deps.acceptedEventTypes.includes(event.event_type)) return;
      const isReceipt = event.event_type === "ReceiptExtractionCompleted";
      const isProgress = ["ReceiptReviewRequired", "ReceiptReviewResolved", "ClaimSubmitted"].includes(event.event_type);
      if ((!isReceipt && !isProgress) || await deps.wasProcessed(event.event_id)) return;
      const claimId = event.payload.claimId;
      if (!claimId) return;
      const target = await deps.findNotificationTarget(claimId);
      if (!target) return;
      const context = {
        actorEmployeeId: target.employeeId,
        actorRole: "EMPLOYEE" as const,
        channel: "FEISHU" as const,
        conversationId: target.conversationId,
        toolCallId: `event:${event.event_id}:read`,
        idempotencyKey: `event:${event.event_id}:read`,
        claimId,
      };
      const current = isReceipt
        ? { workbench: await deps.port.getClaimWorkbench(context) }
        : { progress: await deps.port.getOwnedClaimProgress(context) };
      await deps.notify({ eventId: event.event_id, eventType: event.event_type, claimId, ...(isReceipt ? { receiptId: event.aggregate_id } : {}), conversationId: target.conversationId, chatId: target.chatId, ...current });
      await deps.markProcessed(event.event_id);
    },
  };
}
