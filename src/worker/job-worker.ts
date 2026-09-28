import { runAsyncJobWorkerOnce } from "@/src/application/run-async-job-worker";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const pollIntervalMs = Number(process.env.JOB_WORKER_POLL_INTERVAL_MS ?? 1_000);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) throw new Error("JOB_WORKER_POLL_INTERVAL_MS must be an integer of at least 100");
  const prisma = createPrismaClient(databaseUrl);
  const jobs = new PrismaAsyncJobRepository(prisma);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await prisma.$connect();
    while (!stopping) {
      const processed = await runAsyncJobWorkerOnce({
        jobs,
        process: async () => ({ type: "RETRY_WAIT", failureCode: "WORKER_PROCESSOR_UNAVAILABLE" }),
        now: () => new Date(),
        leaseMs: 60_000,
      });
      if (!processed) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error("Async job worker failed");
  process.exitCode = 1;
});
