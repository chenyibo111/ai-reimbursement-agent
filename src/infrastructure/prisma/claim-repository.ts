import type { PrismaClient } from "@/generated/prisma/client";
import type { ClaimSummary } from "@/src/application/get-claim-summary";
import type { Claim, ClaimStatus } from "@/src/domain/claim";
import { formatProposalValue, type AgentProposalField } from "@/src/domain/agent-proposal";

export type CreateClaimDraft = {
  employeeId: string;
  purpose: string | null;
  status: ClaimStatus;
};

export type ClaimDraftPatch = Partial<Pick<Claim, "purpose" | "status">>;

export class PrismaClaimRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateClaimDraft): Promise<Claim> {
    const draft = await this.prisma.claimDraft.create({
      data: input,
    });

    return toClaim(draft);
  }

  async getByIdOrThrow(id: string): Promise<Claim> {
    const draft = await this.prisma.claimDraft.findUnique({ where: { id } });
    if (!draft) {
      throw new Error("claim not found");
    }
    return toClaim(draft);
  }

  async updateDraft(id: string, expectedVersion: number, patch: ClaimDraftPatch): Promise<Claim> {
    const updated = await this.prisma.claimDraft.updateMany({
      where: {
        id,
        version: expectedVersion,
        status: { not: "SUBMITTED" },
      },
      data: {
        ...patch,
        version: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      throw new Error("version conflict");
    }

    return this.getByIdOrThrow(id);
  }

  async toSummary(id: string): Promise<ClaimSummary> {
    const draft = await this.prisma.claimDraft.findUnique({
      where: { id },
      include: {
        receipts: true,
        expenseItems: true,
        validationResults: true,
        agentProposals: {
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        },
      },
    });
    if (!draft) {
      throw new Error("claim not found");
    }
    const expensesById = new Map(draft.expenseItems.map((item) => [item.id, item]));
    const receiptsById = new Map(draft.receipts.map((receipt) => [receipt.id, receipt]));

    return {
      id: draft.id,
      employeeId: draft.employeeId,
      status: draft.status,
      version: draft.version,
      purpose: draft.purpose,
      totalAmountCents: draft.expenseItems.reduce((total, item) => total + item.amountCents, 0),
      receipts: draft.receipts,
      expenseItems: draft.expenseItems,
      validationResults: draft.validationResults,
      agentProposals: draft.agentProposals.map((proposal) => ({
        id: proposal.id,
        target: proposal.targetRef,
        field: proposal.field,
        displayValue: formatProposalValue({ field: proposal.field as AgentProposalField, value: proposal.value as string | number }),
        ...proposalBusinessContext(proposal, draft.purpose, expensesById, receiptsById),
        reason: proposal.reason,
        status: proposal.status,
        claimVersion: proposal.claimVersion,
        createdAt: proposal.createdAt.toISOString(),
        resolvedAt: proposal.resolvedAt?.toISOString() ?? null,
      })),
    };
  }

  async resolveAgentProposal(input: { actorId: string; claimId: string; proposalId: string; action: "ACCEPT" | "REJECT"; expectedVersion: number }) {
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claimDraft.findUnique({ where: { id: input.claimId } });
      if (!claim) throw new Error("claim not found");
      if (claim.employeeId !== input.actorId) throw new Error("forbidden");
      const proposal = await tx.agentFieldProposal.findFirst({ where: { id: input.proposalId, claimId: input.claimId } });
      if (!proposal) throw new Error("proposal not found");
      if (proposal.status === "PENDING" && proposal.claimVersion < claim.version) {
        await tx.agentFieldProposal.updateMany({ where: { claimId: input.claimId, status: "PENDING", claimVersion: { lt: claim.version } }, data: { status: "EXPIRED", resolvedAt: new Date() } });
      }
      if (claim.status !== "DRAFT" || proposal.status !== "PENDING" || proposal.claimVersion !== input.expectedVersion || claim.version !== input.expectedVersion) throw new Error("version conflict");

      const patch = input.action === "ACCEPT" && proposal.targetRef === "claim" ? proposalPatch(proposal) : {};
      const expenseUpdate = input.action === "ACCEPT" && proposal.expenseItemId ? expensePatch(proposal) : undefined;
      const updated = await tx.claimDraft.updateMany({ where: { id: input.claimId, version: input.expectedVersion, status: "DRAFT" }, data: { ...patch, version: { increment: 1 } } });
      if (updated.count !== 1) throw new Error("version conflict");
      if (input.action === "ACCEPT" && proposal.expenseItemId && expenseUpdate) {
        const item = await tx.expenseItem.updateMany({ where: { id: proposal.expenseItemId, claimId: input.claimId }, data: expenseUpdate });
        if (item.count !== 1) throw new Error("proposal not found");
      }
      const resolved = await tx.agentFieldProposal.update({ where: { id: proposal.id }, data: { status: input.action === "ACCEPT" ? "ACCEPTED" : "REJECTED", resolvedAt: new Date() } });
      await tx.agentFieldProposal.updateMany({ where: { claimId: input.claimId, status: "PENDING", claimVersion: input.expectedVersion }, data: { status: "EXPIRED", resolvedAt: new Date() } });
      await tx.auditEvent.create({ data: { claimId: input.claimId, actorId: input.actorId, type: input.action === "ACCEPT" ? "AGENT_FIELD_ACCEPTED" : "AGENT_FIELD_REJECTED", payload: { proposalId: proposal.id, field: proposal.field } } });
      if (input.action === "ACCEPT") await tx.auditEvent.create({ data: { claimId: input.claimId, actorId: input.actorId, type: "CLAIM_FIELD_UPDATED", payload: { field: proposal.field, expenseItemId: proposal.expenseItemId, source: "USER_ENTERED", value: proposal.value } } });
      return { proposal: { id: resolved.id, status: resolved.status }, version: input.expectedVersion + 1 };
    });
  }
}

function proposalBusinessContext(
  proposal: { targetRef: string; field: string; expenseItemId: string | null },
  purpose: string | null,
  expensesById: Map<string, { receiptId: string | null; amountCents: number; invoiceNumber: string | null; issuedOn: Date | null }>,
  receiptsById: Map<string, { id: string; originalFilename: string | null }>,
) {
  if (proposal.targetRef === "claim") return { targetLabel: "报销草稿", currentValue: purpose?.trim() || "未填写" };
  const expense = proposal.expenseItemId ? expensesById.get(proposal.expenseItemId) : undefined;
  const receipt = expense?.receiptId ? receiptsById.get(expense.receiptId) : undefined;
  const targetLabel = receipt?.originalFilename?.trim() || (receipt ? `票据 #${receipt.id.slice(-6).toUpperCase()}` : "关联票据");
  const current = proposal.field === "invoiceNumber" ? expense?.invoiceNumber : proposal.field === "issuedOn" ? expense?.issuedOn?.toISOString().slice(0, 10) : proposal.field === "totalAmountCents" ? expense?.amountCents : null;
  return { targetLabel, currentValue: current === null || current === undefined || current === "" ? "未填写" : formatProposalValue({ field: proposal.field as AgentProposalField, value: current }) };
}

function proposalPatch(proposal: { targetRef: string; field: string; value: unknown }) {
  if (proposal.targetRef !== "claim" || proposal.field !== "purpose" || typeof proposal.value !== "string" || !proposal.value.trim()) throw new Error("invalid proposal");
  return { purpose: proposal.value.trim() };
}

function expensePatch(proposal: { targetRef: string; field: string; value: unknown }) {
  if (!/^expense-[1-9]\d*$/.test(proposal.targetRef)) throw new Error("invalid proposal");
  if (proposal.field === "invoiceNumber" && typeof proposal.value === "string") return { invoiceNumber: proposal.value, invoiceSource: "USER_ENTERED" as const };
  if (proposal.field === "issuedOn" && typeof proposal.value === "string") return { issuedOn: new Date(proposal.value), issuedOnSource: "USER_ENTERED" as const };
  if (proposal.field === "totalAmountCents" && typeof proposal.value === "number" && Number.isInteger(proposal.value)) return { amountCents: proposal.value, amountSource: "USER_ENTERED" as const };
  throw new Error("invalid proposal");
}

function toClaim(draft: {
  id: string;
  employeeId: string;
  status: ClaimStatus;
  purpose: string | null;
  version: number;
}): Claim {
  return {
    id: draft.id,
    employeeId: draft.employeeId,
    status: draft.status,
    purpose: draft.purpose,
    version: draft.version,
  };
}
