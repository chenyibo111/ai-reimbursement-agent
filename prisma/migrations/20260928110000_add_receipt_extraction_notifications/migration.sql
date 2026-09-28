CREATE TYPE "ReceiptExtractionNotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_WAIT', 'SENT', 'CLOSED');

CREATE TABLE "ReceiptExtractionNotification" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "receiptId" TEXT,
    "claimId" TEXT,
    "conversationId" TEXT NOT NULL,
    "channel" "AgentMessageChannel" NOT NULL DEFAULT 'FEISHU',
    "chatId" TEXT NOT NULL,
    "status" "ReceiptExtractionNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "failureCode" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptExtractionNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReceiptExtractionNotification_jobId_key" ON "ReceiptExtractionNotification"("jobId");
CREATE INDEX "ReceiptExtractionNotification_status_availableAt_idx" ON "ReceiptExtractionNotification"("status", "availableAt");
CREATE INDEX "ReceiptExtractionNotification_receiptId_idx" ON "ReceiptExtractionNotification"("receiptId");
CREATE INDEX "ReceiptExtractionNotification_claimId_idx" ON "ReceiptExtractionNotification"("claimId");
CREATE INDEX "ReceiptExtractionNotification_conversationId_idx" ON "ReceiptExtractionNotification"("conversationId");

ALTER TABLE "ReceiptExtractionNotification" ADD CONSTRAINT "ReceiptExtractionNotification_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AsyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceiptExtractionNotification" ADD CONSTRAINT "ReceiptExtractionNotification_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReceiptExtractionNotification" ADD CONSTRAINT "ReceiptExtractionNotification_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReceiptExtractionNotification" ADD CONSTRAINT "ReceiptExtractionNotification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
