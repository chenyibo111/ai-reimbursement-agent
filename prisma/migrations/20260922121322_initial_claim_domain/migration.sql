-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'PROCESSING', 'NEEDS_INFORMATION', 'AWAITING_CONFIRMATION', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "FieldSource" AS ENUM ('EXTRACTED', 'USER_ENTERED', 'SYSTEM_CALCULATED');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'EXTRACTING', 'EXTRACTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ValidationSeverity" AS ENUM ('BLOCKING', 'WARNING');

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "department" TEXT,
    "feishuUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimDraft" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "purpose" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "receiptType" TEXT,
    "extractionPayload" JSONB,
    "extractionVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseItem" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "receiptId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "amountSource" "FieldSource" NOT NULL,
    "issuedOn" TIMESTAMP(3),
    "issuedOnSource" "FieldSource",
    "invoiceNumber" TEXT,
    "invoiceSource" "FieldSource",
    "expenseCategory" TEXT,
    "participants" TEXT,
    "projectCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clarification" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "answer" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clarification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationResult" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "ValidationSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionSnapshot" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "claimVersion" INTEGER NOT NULL,
    "submissionNumber" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_feishuUserId_key" ON "Employee"("feishuUserId");

-- CreateIndex
CREATE INDEX "ClaimDraft_employeeId_status_idx" ON "ClaimDraft"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_objectKey_key" ON "Receipt"("objectKey");

-- CreateIndex
CREATE INDEX "Receipt_claimId_contentHash_idx" ON "Receipt"("claimId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseItem_receiptId_key" ON "ExpenseItem"("receiptId");

-- CreateIndex
CREATE INDEX "ValidationResult_claimId_severity_idx" ON "ValidationResult"("claimId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionSnapshot_submissionNumber_key" ON "SubmissionSnapshot"("submissionNumber");

-- CreateIndex
CREATE INDEX "AuditEvent_claimId_createdAt_idx" ON "AuditEvent"("claimId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClaimDraft" ADD CONSTRAINT "ClaimDraft_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseItem" ADD CONSTRAINT "ExpenseItem_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseItem" ADD CONSTRAINT "ExpenseItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clarification" ADD CONSTRAINT "Clarification_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionSnapshot" ADD CONSTRAINT "SubmissionSnapshot_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
