import { z } from "zod";

import type { AuditEventWriter } from "@/src/application/audit-event";
import type { AgentContext } from "@/src/application/build-agent-context";
import { parseAgentProposal, type AgentProposalField, type AgentProposalInput } from "@/src/domain/agent-proposal";
import type { ValidationIssue } from "@/src/domain/claim-validation";
import type { ChatModel } from "@/src/infrastructure/model/chat-model";

const decisionSchema = z.object({ reply: z.string().trim().min(1).max(2_000), proposals: z.array(z.unknown()).default([]) }).strict();

export type AgentProposalDto = {
  id: string;
  target: string;
  field: string;
  displayValue: string;
  reason: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  claimVersion: number;
};

export type AgentTurnResult = { reply: string; clarifications: Array<{ field: string; prompt: string }>; proposals: AgentProposalDto[] };

export type RunAgentTurnDeps = {
  model: ChatModel;
  getContext(actorId: string, claimId: string): Promise<AgentContext>;
  createProposal(input: AgentProposalInput & { actorId: string; claimId: string; claimVersion: number; expenseItemId?: string }): Promise<AgentProposalDto>;
  audit: AuditEventWriter;
};

export async function runAgentTurn(input: { actorId: string; claimId: string; message: string }, deps: RunAgentTurnDeps): Promise<AgentTurnResult> {
  const message = input.message.trim();
  if (!message || message.length > 2_000) throw new Error("message is invalid");
  const context = await deps.getContext(input.actorId, input.claimId);
  const raw = await deps.model.decide({ message, claimId: input.claimId, summary: { ...context.summary, allowedTargets: context.allowedTargets }, issues: context.issues });
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    await rejectModelResponse(input, deps.audit);
    return fallback(context.issues);
  }

  const proposals: AgentProposalDto[] = [];
  for (const candidate of parsed.data.proposals) {
    try {
      const proposal = parseAgentProposal(candidate);
      if (!isAllowed(context, proposal)) throw new Error("proposal target is unavailable");
      const expenseItemId = context.targetMap[proposal.target]?.expenseItemId;
      proposals.push(await deps.createProposal({ ...proposal, actorId: input.actorId, claimId: input.claimId, claimVersion: context.claimVersion, expenseItemId }));
    } catch {
      await rejectModelResponse(input, deps.audit);
    }
  }
  return { reply: parsed.data.reply, clarifications: toClarifications(context.issues), proposals };
}

function isAllowed(context: AgentContext, proposal: AgentProposalInput) {
  return context.allowedTargets.some((target) => target.target === proposal.target && target.fields.includes(proposal.field as AgentProposalField));
}
async function rejectModelResponse(input: { actorId: string; claimId: string }, audit: AuditEventWriter) { await audit.append({ type: "MODEL_RESPONSE_REJECTED", actorId: input.actorId, claimId: input.claimId, payload: {} }); }
function fallback(issues: ValidationIssue[]): AgentTurnResult { return { reply: "请在表单中确认字段。", clarifications: toClarifications(issues), proposals: [] }; }
function toClarifications(issues: ValidationIssue[]): Array<{ field: string; prompt: string }> {
  const priority: Record<string, number> = { CONFIRM_TOTAL_AMOUNT: 0, CONFIRM_ISSUED_ON: 1, CONFIRM_INVOICE_NUMBER: 2, PURPOSE_REQUIRED: 3 };
  return issues.filter((issue) => issue.severity === "BLOCKING" && issue.code in priority).sort((a, b) => priority[a.code] - priority[b.code]).map((issue) => ({ field: fieldFor(issue.code), prompt: promptFor(issue.code) }));
}
function fieldFor(code: string): string { return { CONFIRM_TOTAL_AMOUNT: "totalAmountCents", CONFIRM_ISSUED_ON: "issuedOn", CONFIRM_INVOICE_NUMBER: "invoiceNumber", PURPOSE_REQUIRED: "purpose" }[code] ?? code; }
function promptFor(code: string): string { return { CONFIRM_TOTAL_AMOUNT: "请确认金额", CONFIRM_ISSUED_ON: "请确认开票日期", CONFIRM_INVOICE_NUMBER: "请确认发票号码", PURPOSE_REQUIRED: "请填写报销事由" }[code] ?? "请补充信息"; }
