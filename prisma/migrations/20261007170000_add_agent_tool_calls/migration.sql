CREATE TABLE "AgentToolCall" (
    "toolCallId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentToolCall_pkey" PRIMARY KEY ("toolCallId")
);

CREATE INDEX "AgentToolCall_conversationId_completedAt_idx" ON "AgentToolCall"("conversationId", "completedAt");
