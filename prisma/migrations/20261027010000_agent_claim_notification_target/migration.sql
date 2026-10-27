CREATE TABLE "public"."AgentClaimNotificationTarget" (
  "claimId" TEXT NOT NULL PRIMARY KEY,
  "employeeId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentClaimNotificationTarget_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "public"."AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentClaimNotificationTarget_employeeId_idx" ON "public"."AgentClaimNotificationTarget"("employeeId");
