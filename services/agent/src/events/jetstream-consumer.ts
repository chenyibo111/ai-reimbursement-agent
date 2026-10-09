export type ReceiptExtractionEvent = {
  event_id: string;
  event_type: string;
  aggregate_id: string;
  payload: { claimId?: string };
};

type JetStreamMessage = {
  data: Uint8Array;
  ack(): void;
  nak(delayMs?: number): void;
};

/**
 * Processes one durable JetStream delivery at a time. A message remains
 * unacknowledged until its Agent-side effect has completed successfully.
 */
export async function consumeReceiptExtractionEvents(deps: {
  consumer: { next(input: { expires: number }): Promise<JetStreamMessage | null> };
  handle(event: ReceiptExtractionEvent): Promise<void>;
  shouldContinue(): boolean;
  pollTimeoutMs?: number;
  retryDelayMs?: number;
}): Promise<void> {
  const pollTimeoutMs = deps.pollTimeoutMs ?? 30_000;
  const retryDelayMs = deps.retryDelayMs ?? 5_000;
  while (deps.shouldContinue()) {
    const message = await deps.consumer.next({ expires: pollTimeoutMs });
    if (!message) continue;
    try {
      const event = parseReceiptExtractionEvent(message.data);
      await deps.handle(event);
      message.ack();
    } catch {
      message.nak(retryDelayMs);
    }
  }
}

function parseReceiptExtractionEvent(data: Uint8Array): ReceiptExtractionEvent {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid reimbursement event");
  const event = parsed as Record<string, unknown>;
  if (typeof event.event_id !== "string" || typeof event.event_type !== "string" || typeof event.aggregate_id !== "string" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("invalid reimbursement event");
  }
  const claimId = (event.payload as Record<string, unknown>).claimId;
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    aggregate_id: event.aggregate_id,
    payload: typeof claimId === "string" ? { claimId } : {},
  };
}
