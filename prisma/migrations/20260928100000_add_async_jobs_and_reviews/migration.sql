CREATE TYPE "EmployeeRole" AS ENUM ('EMPLOYEE', 'FINANCE_REVIEWER', 'ADMIN');
CREATE TYPE "AsyncJobKind" AS ENUM ('RECEIPT_EXTRACTION', 'POLICY_SOURCE_SYNC');
CREATE TYPE "AsyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY_WAIT', 'REVIEW_REQUIRED', 'SUCCEEDED', 'CLOSED');
CREATE TYPE "ReviewCaseKind" AS ENUM ('RECEIPT_OCR', 'POLICY_SYNC');
CREATE TYPE "ReviewCaseStatus" AS ENUM ('OPEN', 'CLAIMED', 'RESOLVED', 'CLOSED');

ALTER TABLE "Employee" ADD COLUMN "role" "EmployeeRole" NOT NULL DEFAULT 'EMPLOYEE';
CREATE INDEX "Employee_role_idx" ON "Employee"("role");

CREATE TABLE "AsyncJob" (
    "id" TEXT NOT NULL,
    "kind" "AsyncJobKind" NOT NULL,
    "status" "AsyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "claimId" TEXT,
    "receiptId" TEXT,
    "policySourceId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "failureCode" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AsyncJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AsyncJob_target_matches_kind" CHECK (
      ("kind" = 'RECEIPT_EXTRACTION' AND "claimId" IS NOT NULL AND "receiptId" IS NOT NULL AND "policySourceId" IS NULL)
      OR ("kind" = 'POLICY_SOURCE_SYNC' AND "claimId" IS NULL AND "receiptId" IS NULL AND "policySourceId" IS NOT NULL)
    )
);

CREATE INDEX "AsyncJob_status_availableAt_idx" ON "AsyncJob"("status", "availableAt");
CREATE INDEX "AsyncJob_receiptId_idx" ON "AsyncJob"("receiptId");
CREATE INDEX "AsyncJob_policySourceId_idx" ON "AsyncJob"("policySourceId");
CREATE UNIQUE INDEX "AsyncJob_one_active_receipt_extraction" ON "AsyncJob"("kind", "receiptId")
  WHERE "receiptId" IS NOT NULL AND "status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT');
CREATE UNIQUE INDEX "AsyncJob_one_active_policy_sync" ON "AsyncJob"("kind", "policySourceId")
  WHERE "policySourceId" IS NOT NULL AND "status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT');

ALTER TABLE "AsyncJob" ADD CONSTRAINT "AsyncJob_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AsyncJob" ADD CONSTRAINT "AsyncJob_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AsyncJob" ADD CONSTRAINT "AsyncJob_policySourceId_fkey" FOREIGN KEY ("policySourceId") REFERENCES "PolicySource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReviewCase" (
    "id" TEXT NOT NULL,
    "kind" "ReviewCaseKind" NOT NULL,
    "status" "ReviewCaseStatus" NOT NULL DEFAULT 'OPEN',
    "jobId" TEXT NOT NULL,
    "claimId" TEXT,
    "receiptId" TEXT,
    "policySourceId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "assignedReviewerId" TEXT,
    "resolution" JSONB,
    "claimedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReviewCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReviewCase_kind_status_createdAt_idx" ON "ReviewCase"("kind", "status", "createdAt");
CREATE INDEX "ReviewCase_assignedReviewerId_status_idx" ON "ReviewCase"("assignedReviewerId", "status");
CREATE UNIQUE INDEX "ReviewCase_one_open_per_job" ON "ReviewCase"("jobId") WHERE "status" IN ('OPEN', 'CLAIMED');

ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AsyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_policySourceId_fkey" FOREIGN KEY ("policySourceId") REFERENCES "PolicySource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewCase" ADD CONSTRAINT "ReviewCase_assignedReviewerId_fkey" FOREIGN KEY ("assignedReviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
