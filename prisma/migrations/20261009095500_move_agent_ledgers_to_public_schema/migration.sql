-- The Agent service owns these ledgers through Prisma's public schema.
-- Earlier local migration execution created them under reimbursement instead.
ALTER TABLE IF EXISTS reimbursement."AgentToolCall" SET SCHEMA public;
ALTER TABLE IF EXISTS reimbursement."AgentProcessedEvent" SET SCHEMA public;
