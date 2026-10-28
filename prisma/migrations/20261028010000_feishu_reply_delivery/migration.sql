ALTER TYPE "InboundChannelEventStatus" ADD VALUE IF NOT EXISTS 'REPLY_PENDING';
ALTER TYPE "InboundChannelEventStatus" ADD VALUE IF NOT EXISTS 'REPLY_PROCESSING';
ALTER TYPE "InboundChannelEventStatus" ADD VALUE IF NOT EXISTS 'REPLY_RETRYABLE';
ALTER TYPE "InboundChannelEventStatus" ADD VALUE IF NOT EXISTS 'REPLY_FAILED';

ALTER TABLE "InboundChannelEvent"
  ADD COLUMN "replyText" TEXT,
  ADD COLUMN "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDeliveryAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE INDEX "InboundChannelEvent_delivery_due_idx" ON "InboundChannelEvent"("status", "nextDeliveryAttemptAt", "receivedAt");
