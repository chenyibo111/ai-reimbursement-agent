-- Pending proposals are suggestions only; employee confirmation changes the draft.
CREATE TYPE "AgentProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

CREATE TABLE "AgentFieldProposal" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "expenseItemId" TEXT,
    "targetRef" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "claimVersion" INTEGER NOT NULL,
    "status" "AgentProposalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AgentFieldProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentFieldProposal_claimId_status_idx" ON "AgentFieldProposal"("claimId", "status");
CREATE INDEX "AgentFieldProposal_claimId_createdAt_idx" ON "AgentFieldProposal"("claimId", "createdAt");

ALTER TABLE "AgentFieldProposal" ADD CONSTRAINT "AgentFieldProposal_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentFieldProposal" ADD CONSTRAINT "AgentFieldProposal_expenseItemId_fkey" FOREIGN KEY ("expenseItemId") REFERENCES "ExpenseItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
