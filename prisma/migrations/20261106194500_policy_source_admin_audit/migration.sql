ALTER TABLE "AsyncJob" ADD COLUMN "requestedByEmployeeId" TEXT;

CREATE TABLE "PolicySourceAuditEvent" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicySourceAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PolicySourceAuditEvent_sourceId_createdAt_idx" ON "PolicySourceAuditEvent"("sourceId", "createdAt");
CREATE INDEX "PolicySourceAuditEvent_jobId_idx" ON "PolicySourceAuditEvent"("jobId");
ALTER TABLE "PolicySourceAuditEvent" ADD CONSTRAINT "PolicySourceAuditEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "PolicySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
