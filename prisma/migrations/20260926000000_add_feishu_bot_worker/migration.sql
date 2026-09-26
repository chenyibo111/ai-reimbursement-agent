CREATE TYPE "InboundChannelEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'RETRYABLE');

CREATE TABLE "InboundChannelEvent" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'FEISHU',
    "eventId" TEXT NOT NULL,
    "messageId" TEXT,
    "messageType" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "senderOpenId" TEXT NOT NULL,
    "status" "InboundChannelEventStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "claimId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundChannelEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeishuConversation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeishuConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboundChannelEvent_eventId_key" ON "InboundChannelEvent"("eventId");
CREATE UNIQUE INDEX "InboundChannelEvent_messageId_key" ON "InboundChannelEvent"("messageId");
CREATE INDEX "InboundChannelEvent_status_receivedAt_idx" ON "InboundChannelEvent"("status", "receivedAt");
CREATE INDEX "InboundChannelEvent_chatId_senderOpenId_idx" ON "InboundChannelEvent"("chatId", "senderOpenId");
CREATE UNIQUE INDEX "FeishuConversation_employeeId_chatId_key" ON "FeishuConversation"("employeeId", "chatId");
CREATE INDEX "FeishuConversation_claimId_idx" ON "FeishuConversation"("claimId");

ALTER TABLE "InboundChannelEvent" ADD CONSTRAINT "InboundChannelEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeishuConversation" ADD CONSTRAINT "FeishuConversation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeishuConversation" ADD CONSTRAINT "FeishuConversation_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
