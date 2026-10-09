import type { ReimbursementPort, ToolCallContext } from "../ports/reimbursement-port";

export type ReimbursementToolName = "create_claim_draft" | "create_upload_session" | "finalize_receipt_upload" | "get_claim_workbench" | "update_claim_fields" | "get_claim_validation" | "request_submission_confirmation" | "submit_claim";
export type ToolCall = ToolCallContext & { name: ReimbursementToolName; arguments: Record<string, unknown> };

export interface ToolCallResultStore {
  findCompleted(toolCallId: string): Promise<Record<string, unknown> | null>;
  saveCompleted(input: { toolCallId: string; conversationId: string; toolName: ReimbursementToolName; result: Record<string, unknown> }): Promise<void>;
}

export class ReimbursementToolGateway {
  constructor(private readonly port: ReimbursementPort, private readonly results: ToolCallResultStore) {}

  async execute(call: ToolCall): Promise<Record<string, unknown>> {
    assertContext(call);
    const replay = await this.results.findCompleted(call.toolCallId);
    if (replay) return replay;
    const context: ToolCallContext = { actorEmployeeId: call.actorEmployeeId, actorRole: call.actorRole, channel: call.channel, conversationId: call.conversationId, toolCallId: call.toolCallId, idempotencyKey: call.idempotencyKey };
    let result: Record<string, unknown>;
    switch (call.name) {
      case "create_claim_draft": result = { claim: await this.port.createClaimDraft({ ...context, purpose: requiredString(call.arguments, "purpose") }) }; break;
      case "create_upload_session": result = { upload: await this.port.createUploadSession({ ...context, claimId: requiredString(call.arguments, "claimId"), filename: requiredString(call.arguments, "filename"), contentType: requiredString(call.arguments, "contentType"), sizeBytes: requiredNumber(call.arguments, "sizeBytes") }) }; break;
      case "finalize_receipt_upload": result = { receipt: await this.port.finalizeReceiptUpload({ ...context, claimId: requiredString(call.arguments, "claimId"), receiptId: requiredString(call.arguments, "receiptId") }) }; break;
      case "get_claim_workbench": result = { workbench: await this.port.getClaimWorkbench({ ...context, claimId: requiredString(call.arguments, "claimId") }) }; break;
      case "update_claim_fields": result = { claim: await this.port.updateClaimFields({ ...context, claimId: requiredString(call.arguments, "claimId"), version: requiredNumber(call.arguments, "version"), ...(typeof call.arguments.purpose === "string" ? { purpose: call.arguments.purpose } : {}) }) }; break;
      case "get_claim_validation": result = { validation: await this.port.getClaimValidation({ ...context, claimId: requiredString(call.arguments, "claimId") }) }; break;
      case "request_submission_confirmation": result = { confirmation: await this.port.requestSubmissionConfirmation({ ...context, claimId: requiredString(call.arguments, "claimId"), version: requiredNumber(call.arguments, "version") }) }; break;
      case "submit_claim": result = { submission: await this.port.submitClaim({ ...context, claimId: requiredString(call.arguments, "claimId"), confirmationToken: requiredString(call.arguments, "confirmationToken") }) }; break;
    }
    await this.results.saveCompleted({ toolCallId: call.toolCallId, conversationId: call.conversationId, toolName: call.name, result });
    return result;
  }
}

function assertContext(value: ToolCallContext) {
  if (!value.actorEmployeeId || !value.actorRole || !value.conversationId || !value.toolCallId || !value.idempotencyKey) throw new Error("tool call context is incomplete");
}
function requiredString(value: Record<string, unknown>, field: string) {
  if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`invalid ${field}`);
  return value[field];
}
function requiredNumber(value: Record<string, unknown>, field: string) {
  if (typeof value[field] !== "number" || !Number.isFinite(value[field])) throw new Error(`invalid ${field}`);
  return value[field];
}
