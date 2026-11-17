CREATE TABLE "AgentEventNotificationSnapshot" (
    "eventId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentEventNotificationSnapshot_pkey" PRIMARY KEY ("eventId")
);

ALTER TABLE "ReceiptExtractionNotification"
    ADD COLUMN "templateVersion" INTEGER,
    ADD COLUMN "templateEnabled" BOOLEAN,
    ADD COLUMN "templateText" TEXT,
    ADD COLUMN "renderedText" TEXT;
