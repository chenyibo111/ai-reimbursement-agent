import { z } from "zod";

import type { AuditEventWriter } from "@/src/application/audit-event";
import { allowedAgentTools, type AllowedAgentTool } from "@/src/domain/agent";
import type { ValidationIssue } from "@/src/domain/claim-validation";
import type { ChatModel } from "@/src/infrastructure/model/chat-model";

const decisionSchema = z.object({
  reply: z.string().min(1),
  toolCalls: z.array(z.object({ name: z.enum(allowedAgentTools), args: z.record(z.string(), z.unknown()) })),
});

export type AgentTurnResult = {
  reply: string;
  clarifications: Array<{ field: string; prompt: string }>;
  toolEvents: Array<{ name: AllowedAgentTool; success: boolean }>;
};

export type RunAgentTurnDeps = {
  model: ChatModel;
  getSummary(actorId: string, claimId: string): Promise<unknown>;
  validate(actorId: string, claimId: string): Promise<ValidationIssue[]>;
  audit: AuditEventWriter;
};

export async function runAgentTurn(input: { actorId: string; claimId: string; message: string }, deps: RunAgentTurnDeps): Promise<AgentTurnResult> {
  const [summary, issues] = await Promise.all([deps.getSummary(input.actorId, input.claimId), deps.validate(input.actorId, input.claimId)]);
  const raw = await deps.model.decide({ message: input.message, claimId: input.claimId, summary, issues });
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    await deps.audit.append({ type: "MODEL_RESPONSE_REJECTED", actorId: input.actorId, claimId: input.claimId, payload: {} });
    return { reply: "请在表单中确认字段。", clarifications: toClarifications(issues), toolEvents: [] };
  }
  return { reply: parsed.data.reply, clarifications: toClarifications(issues), toolEvents: parsed.data.toolCalls.map((call) => ({ name: call.name, success: true })) };
}

function toClarifications(issues: ValidationIssue[]): Array<{ field: string; prompt: string }> {
  const priority: Record<string, number> = { CONFIRM_TOTAL_AMOUNT: 0, CONFIRM_ISSUED_ON: 1, CONFIRM_INVOICE_NUMBER: 2, PURPOSE_REQUIRED: 3 };
  return issues.filter((issue) => issue.severity === "BLOCKING" && issue.code in priority).sort((a, b) => priority[a.code] - priority[b.code]).map((issue) => ({ field: fieldFor(issue.code), prompt: promptFor(issue.code) }));
}

function fieldFor(code: string): string { return { CONFIRM_TOTAL_AMOUNT: "totalAmountCents", CONFIRM_ISSUED_ON: "issuedOn", CONFIRM_INVOICE_NUMBER: "invoiceNumber", PURPOSE_REQUIRED: "purpose" }[code] ?? code; }
function promptFor(code: string): string { return { CONFIRM_TOTAL_AMOUNT: "请确认金额", CONFIRM_ISSUED_ON: "请确认开票日期", CONFIRM_INVOICE_NUMBER: "请确认发票号码", PURPOSE_REQUIRED: "请填写报销事由" }[code] ?? "请补充信息"; }
