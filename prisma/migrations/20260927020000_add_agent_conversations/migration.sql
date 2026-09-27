CREATE TYPE "AgentConversationKind" AS ENUM ('PRIVATE', 'GROUP');
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "AgentMessageChannel" AS ENUM ('WEB', 'FEISHU');
CREATE TYPE "ReimbursementIntakeStatus" AS ENUM ('COLLECTING', 'READY_TO_SUBMIT', 'SUBMITTED', 'ABANDONED');

CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "kind" "AgentConversationKind" NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "summaryThroughSequence" INTEGER NOT NULL DEFAULT 0,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "AgentMessageRole" NOT NULL,
    "channel" "AgentMessageChannel" NOT NULL,
    "channelMessageId" TEXT,
    "text" TEXT NOT NULL,
    "citations" JSONB,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReimbursementIntake" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ReimbursementIntakeStatus" NOT NULL DEFAULT 'COLLECTING',
    "claimId" TEXT,
    "conversationId" TEXT NOT NULL,
    "collectedFields" JSONB NOT NULL DEFAULT '{}',
    "pendingFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "submissionToken" TEXT,
    "lastUserConfirmationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReimbursementIntake_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentConversation_employeeId_kind_scopeKey_key" ON "AgentConversation"("employeeId", "kind", "scopeKey");
CREATE INDEX "AgentConversation_employeeId_lastActiveAt_idx" ON "AgentConversation"("employeeId", "lastActiveAt");
CREATE UNIQUE INDEX "AgentMessage_conversationId_sequence_key" ON "AgentMessage"("conversationId", "sequence");
CREATE UNIQUE INDEX "AgentMessage_channelMessageId_key" ON "AgentMessage"("channelMessageId");
CREATE INDEX "AgentMessage_conversationId_createdAt_idx" ON "AgentMessage"("conversationId", "createdAt");
CREATE INDEX "ReimbursementIntake_employeeId_status_updatedAt_idx" ON "ReimbursementIntake"("employeeId", "status", "updatedAt");
CREATE INDEX "ReimbursementIntake_conversationId_updatedAt_idx" ON "ReimbursementIntake"("conversationId", "updatedAt");
CREATE INDEX "ReimbursementIntake_claimId_idx" ON "ReimbursementIntake"("claimId");
CREATE UNIQUE INDEX "ReimbursementIntake_one_active_per_employee" ON "ReimbursementIntake"("employeeId") WHERE "status" IN ('COLLECTING', 'READY_TO_SUBMIT');

ALTER TABLE "AgentConversation" ADD CONSTRAINT "AgentConversation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReimbursementIntake" ADD CONSTRAINT "ReimbursementIntake_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReimbursementIntake" ADD CONSTRAINT "ReimbursementIntake_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReimbursementIntake" ADD CONSTRAINT "ReimbursementIntake_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
