import { expect, it } from "vitest";

import { createFeishuBotRuntime } from "@/src/worker/feishu-bot-runtime";

function fixture() {
  const calls = { record: 0, processed: 0, retryable: 0, process: 0, replies: 0, close: 0 };
  const pending = [{ id: "inbound-1", eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1", status: "PROCESSING" as const, claimId: null }];
  const runtime = createFeishuBotRuntime({
    repository: {
      recordInbound: async () => {
        calls.record += 1;
        return { id: "inbound-1", shouldProcess: calls.record === 1 };
      },
      claimNextPending: async () => pending.shift() ?? null,
      markProcessed: async () => { calls.processed += 1; },
      markRetryableFailure: async () => { calls.retryable += 1; },
    },
    processEvent: async () => {
      calls.process += 1;
      return { kind: "AGENT_REPLIED", claimId: "claim-1", replyText: "请在工作台确认：https://reimbursement.example.test/claims/claim-1" };
    },
    replyText: async () => { calls.replies += 1; },
    closeConnection: async () => { calls.close += 1; },
  });
  return { runtime, calls, pending };
}

const rawEvent = {
  event_id: "event-1",
  sender: { sender_id: { open_id: "ou-1" } },
  message: { message_id: "om-1", message_type: "text", chat_id: "oc-1" },
};

it("persists a long-connection event once and does not process inside the callback", async () => {
  const { runtime, calls } = fixture();

  await runtime.onEvent(rawEvent);
  await runtime.onEvent(rawEvent);

  expect(calls.record).toBe(2);
  expect(calls.process).toBe(0);
});

it("marks a successfully processed event before sending its safe reply", async () => {
  const { runtime, calls } = fixture();

  await expect(runtime.drainOnce()).resolves.toBe(true);

  expect(calls.process).toBe(1);
  expect(calls.processed).toBe(1);
  expect(calls.replies).toBe(1);
  expect(calls.retryable).toBe(0);
});

it("returns retryable processing failures to the pending queue", async () => {
  const { runtime, calls } = fixture();
  const retryable = createFeishuBotRuntime({
    repository: {
      recordInbound: async () => ({ id: "inbound-1", shouldProcess: true }),
      claimNextPending: async () => ({ id: "inbound-1", eventId: "event-1", messageId: "om-1", messageType: "text", chatId: "oc-1", senderOpenId: "ou-1", status: "PROCESSING", claimId: null }),
      markProcessed: async () => { calls.processed += 1; },
      markRetryableFailure: async (_id, code) => { expect(code).toBe("RETRYABLE_FAILURE"); calls.retryable += 1; },
    },
    processEvent: async () => ({ kind: "RETRYABLE_FAILURE", retryable: true, replyText: "稍后重试" }),
    replyText: async () => { calls.replies += 1; },
  });

  await retryable.drainOnce();

  expect(calls.retryable).toBe(1);
  expect(calls.processed).toBe(0);
});

it("keeps a completed business event processed when sending the reply fails", async () => {
  const { calls, pending } = fixture();
  const runtime = createFeishuBotRuntime({
    repository: {
      recordInbound: async () => ({ id: "inbound-1", shouldProcess: true }),
      claimNextPending: async () => pending.shift() ?? null,
      markProcessed: async () => { calls.processed += 1; },
      markRetryableFailure: async () => { calls.retryable += 1; },
    },
    processEvent: async () => ({ kind: "CLAIM_LINKED", claimId: "claim-1", replyText: "草稿链接" }),
    replyText: async () => { throw new Error("provider body must not escape"); },
  });

  await runtime.drainOnce();

  expect(calls.processed).toBe(1);
  expect(calls.retryable).toBe(0);
});

it("stops new work and closes the long connection during graceful shutdown", async () => {
  const { runtime, calls } = fixture();

  await runtime.stop();
  await expect(runtime.drainOnce()).resolves.toBe(false);

  expect(calls.close).toBe(1);
  expect(calls.process).toBe(0);
});
