import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";

export const REIMBURSEMENT_EVENT_STREAM = "REIMBURSEMENT";
export const AGENT_RECEIPT_EVENT_CONSUMER = "agent-reimbursement-notifications-v1";
export const RECEIPT_EXTRACTION_COMPLETED_SUBJECT = "reimbursement.receipt.extraction_completed.v1";

type ConsumerApi = {
  info(stream: string, consumer: string): Promise<unknown>;
  add(stream: string, config: Record<string, unknown>): Promise<unknown>;
};

/** Creates the durable only once; an existing cursor must never be reset on deploy. */
export async function ensureReceiptExtractionConsumer(manager: { consumers: ConsumerApi }): Promise<void> {
  try {
    await manager.consumers.info(REIMBURSEMENT_EVENT_STREAM, AGENT_RECEIPT_EVENT_CONSUMER);
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "consumer not found") throw error;
  }
  await manager.consumers.add(REIMBURSEMENT_EVENT_STREAM, {
    durable_name: AGENT_RECEIPT_EVENT_CONSUMER,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    filter_subject: RECEIPT_EXTRACTION_COMPLETED_SUBJECT,
    max_deliver: 10,
  });
}
