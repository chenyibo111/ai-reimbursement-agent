import { z } from "zod";

export const agentProposalFields = ["purpose", "invoiceNumber", "issuedOn", "totalAmountCents"] as const;
export type AgentProposalField = (typeof agentProposalFields)[number];

export type AgentTargetRef = "claim" | `expense-${number}`;

export type AgentProposalInput = {
  target: AgentTargetRef;
  field: AgentProposalField;
  value: string | number;
  reason: string;
};

const targetSchema = z.union([z.literal("claim"), z.string().regex(/^expense-[1-9]\d*$/)]);
const textSchema = z.string().trim().min(1).max(500);

const baseSchema = z.object({
  target: targetSchema,
  field: z.enum(agentProposalFields),
  value: z.union([z.string(), z.number()]),
  reason: textSchema,
}).strict();

export function parseAgentProposal(input: unknown): AgentProposalInput {
  const proposal = baseSchema.parse(input);

  if (proposal.target === "claim") {
    if (proposal.field !== "purpose") throw new Error("claim proposals may only update purpose");
    return { ...proposal, target: proposal.target as AgentTargetRef, value: textSchema.parse(proposal.value) };
  }

  if (proposal.field === "purpose") throw new Error("expense proposals may not update purpose");

  if (proposal.field === "totalAmountCents") {
    const value = z.number().int().nonnegative().max(100_000_000).parse(proposal.value);
    return { ...proposal, target: proposal.target as AgentTargetRef, value };
  }

  if (proposal.field === "issuedOn") {
    const value = textSchema.parse(proposal.value);
    if (!isCalendarDate(value)) throw new Error("issuedOn must be a calendar date in YYYY-MM-DD format");
    return { ...proposal, target: proposal.target as AgentTargetRef, value };
  }

  return { ...proposal, target: proposal.target as AgentTargetRef, value: textSchema.parse(proposal.value) };
}

export function formatProposalValue(proposal: Pick<AgentProposalInput, "field" | "value">): string {
  if (proposal.field === "totalAmountCents" && typeof proposal.value === "number") {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(proposal.value / 100);
  }
  return String(proposal.value);
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
