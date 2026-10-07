CREATE TABLE "AgentProcessedEvent" (
    "eventId" TEXT NOT NULL,
    "consumerName" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentProcessedEvent_pkey" PRIMARY KEY ("eventId", "consumerName")
);

CREATE INDEX "AgentProcessedEvent_processedAt_idx" ON "AgentProcessedEvent"("processedAt");
