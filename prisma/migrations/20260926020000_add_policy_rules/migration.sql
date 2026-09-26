CREATE TYPE "PolicyVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "PolicyRuleType" AS ENUM ('CLAIM_TOTAL_MAX', 'CATEGORY_ITEM_MAX', 'CATEGORY_ALLOWED', 'CATEGORY_REQUIRED_FIELD');

CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "PolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdByEmployeeId" TEXT NOT NULL,
    "publishedByEmployeeId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyRule" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PolicyRuleType" NOT NULL,
    "severity" "ValidationSeverity" NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolicyRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyAuditEvent" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PolicyRule_policyVersionId_code_key" ON "PolicyRule"("policyVersionId", "code");
CREATE INDEX "PolicyVersion_status_effectiveFrom_idx" ON "PolicyVersion"("status", "effectiveFrom");
CREATE INDEX "PolicyRule_policyVersionId_sortOrder_idx" ON "PolicyRule"("policyVersionId", "sortOrder");
CREATE INDEX "PolicyAuditEvent_policyVersionId_createdAt_idx" ON "PolicyAuditEvent"("policyVersionId", "createdAt");

ALTER TABLE "PolicyRule" ADD CONSTRAINT "PolicyRule_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyAuditEvent" ADD CONSTRAINT "PolicyAuditEvent_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
