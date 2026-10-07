-- Feishu destinations are Agent-owned channel metadata, never reimbursement-domain data.
ALTER TABLE "AgentConversation"
ADD COLUMN "latestFeishuChatId" TEXT;
