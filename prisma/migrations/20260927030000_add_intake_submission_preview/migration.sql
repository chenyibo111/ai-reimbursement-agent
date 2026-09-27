ALTER TABLE "ReimbursementIntake"
ADD COLUMN "submissionPreview" JSONB;

ALTER TABLE "AgentMessage"
ADD COLUMN "inReplyToChannelMessageId" TEXT;

CREATE UNIQUE INDEX "AgentMessage_inReplyToChannelMessageId_key"
ON "AgentMessage"("inReplyToChannelMessageId");
