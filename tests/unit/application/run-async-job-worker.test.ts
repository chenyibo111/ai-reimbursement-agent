import { expect, it } from "vitest";

import { runAsyncJobWorkerOnce } from "@/src/application/run-async-job-worker";

it("returns false after recovering leases when no job is available", async () => {
  const calls: string[] = [];

  const processed = await runAsyncJobWorkerOnce({
    jobs: {
      recoverExpiredLeases: async () => { calls.push("recover"); return 0; },
      claimNextJob: async () => { calls.push("claim"); return null; },
      markSucceeded: async () => { calls.push("succeeded"); },
      markRetryWait: async () => { calls.push("retry"); },
      markReviewRequired: async () => { calls.push("review"); },
      closeMissingTarget: async () => { calls.push("closed"); },
    },
    process: async () => { calls.push("process"); return { type: "SUCCEEDED" as const }; },
    now: () => new Date("2026-09-28T05:00:00.000Z"),
    leaseMs: 60_000,
  });

  expect(processed).toBe(false);
  expect(calls).toEqual(["recover", "claim"]);
});

it("marks a claimed job successful after the processor completes", async () => {
  const state = { status: "RUNNING" };

  const processed = await runAsyncJobWorkerOnce({
    jobs: {
      recoverExpiredLeases: async () => 0,
      claimNextJob: async () => ({ id: "job-1", kind: "RECEIPT_EXTRACTION" as const, status: "RUNNING" as const }),
      markSucceeded: async () => { state.status = "SUCCEEDED"; },
      markRetryWait: async () => undefined,
      markReviewRequired: async () => undefined,
      closeMissingTarget: async () => undefined,
    },
    process: async () => ({ type: "SUCCEEDED" as const }),
    now: () => new Date("2026-09-28T05:00:00.000Z"),
    leaseMs: 60_000,
  });

  expect(processed).toBe(true);
  expect(state.status).toBe("SUCCEEDED");
});

it("emits lifecycle events with the job correlation fields", async () => {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];

  await runAsyncJobWorkerOnce({
    jobs: {
      recoverExpiredLeases: async () => 1,
      claimNextJob: async () => ({ id: "job-2", kind: "RECEIPT_EXTRACTION" as const, status: "RUNNING" as const }),
      markSucceeded: async () => undefined,
      markRetryWait: async () => undefined,
      markReviewRequired: async () => undefined,
      closeMissingTarget: async () => undefined,
    },
    process: async () => ({ type: "SUCCEEDED" as const }),
    now: () => new Date("2026-09-28T05:00:00.000Z"),
    leaseMs: 60_000,
    logger: {
      info: (event, _message, fields) => events.push({ event, fields }),
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

  expect(events).toEqual([
    { event: "job.lease.recovered", fields: { count: 1 } },
    { event: "job.claimed", fields: { jobId: "job-2", jobKind: "RECEIPT_EXTRACTION" } },
    { event: "job.completed", fields: { jobId: "job-2", jobKind: "RECEIPT_EXTRACTION", status: "SUCCEEDED" } },
  ]);
});
