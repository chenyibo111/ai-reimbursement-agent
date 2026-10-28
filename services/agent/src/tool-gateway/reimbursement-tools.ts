import type { ClaimFieldPatch, OwnedClaimSearchQuery, ReimbursementPort, ToolCallContext } from "../ports/reimbursement-port";

export type ReimbursementToolName = "create_claim_draft" | "create_upload_session" | "finalize_receipt_upload" | "delete_owned_receipt" | "delete_owned_draft" | "get_claim_workbench" | "list_owned_claims" | "search_owned_claims" | "find_owned_claim_by_number" | "update_claim_fields" | "get_claim_validation" | "get_owned_claim_progress" | "request_submission_confirmation" | "submit_claim";
export type ToolCall = ToolCallContext & { name: ReimbursementToolName; arguments: Record<string, unknown> };

export interface ToolCallResultStore {
  findCompleted(toolCallId: string): Promise<Record<string, unknown> | null>;
  saveCompleted(input: { toolCallId: string; conversationId: string; toolName: ReimbursementToolName; result: Record<string, unknown> }): Promise<void>;
}

export class ReimbursementToolGateway {
  constructor(private readonly port: ReimbursementPort, private readonly results: ToolCallResultStore, private readonly onFailure?: (error: unknown, call: ToolCall) => void) {}

  async execute(call: ToolCall): Promise<Record<string, unknown>> {
    assertContext(call);
    const replay = await this.results.findCompleted(call.toolCallId);
    if (replay) return replay;
    const context: ToolCallContext = { actorEmployeeId: call.actorEmployeeId, actorRole: call.actorRole, channel: call.channel, conversationId: call.conversationId, toolCallId: call.toolCallId, idempotencyKey: call.idempotencyKey };
    try {
      let result: Record<string, unknown>;
      switch (call.name) {
      case "create_claim_draft": result = { claim: await this.port.createClaimDraft({ ...context, purpose: optionalPurpose(call.arguments) }) }; break;
      case "create_upload_session": result = { upload: await this.port.createUploadSession({ ...context, claimId: requiredString(call.arguments, "claimId"), filename: requiredString(call.arguments, "filename"), contentType: requiredString(call.arguments, "contentType"), sizeBytes: requiredNumber(call.arguments, "sizeBytes") }) }; break;
      case "finalize_receipt_upload": result = { receipt: await this.port.finalizeReceiptUpload({ ...context, claimId: requiredString(call.arguments, "claimId"), receiptId: requiredString(call.arguments, "receiptId") }) }; break;
      case "delete_owned_receipt": {
		assertOnlyFields(call.arguments, ["claimId", "receiptId", "expectedClaimVersion"]);
        const expectedClaimVersion = requiredNumber(call.arguments, "expectedClaimVersion");
        if (!Number.isSafeInteger(expectedClaimVersion) || expectedClaimVersion < 1) throw new Error("invalid expectedClaimVersion");
        await this.port.deleteOwnedReceipt({ ...context, claimId: requiredString(call.arguments, "claimId"), receiptId: requiredString(call.arguments, "receiptId"), expectedClaimVersion });
        result = { deleted: true }; break;
      }
      case "delete_owned_draft": {
		assertOnlyFields(call.arguments, ["claimId", "expectedClaimVersion"]);
        const expectedClaimVersion = requiredNumber(call.arguments, "expectedClaimVersion");
        if (!Number.isSafeInteger(expectedClaimVersion) || expectedClaimVersion < 1) throw new Error("invalid expectedClaimVersion");
        await this.port.deleteOwnedDraft({ ...context, claimId: requiredString(call.arguments, "claimId"), expectedClaimVersion });
        result = { deleted: true }; break;
      }
      case "get_claim_workbench": result = { workbench: await this.port.getClaimWorkbench({ ...context, claimId: requiredString(call.arguments, "claimId") }) }; break;
      case "list_owned_claims": result = { claims: await this.port.listOwnedClaims({ ...context, limit: requiredNumber(call.arguments, "limit") }) }; break;
      case "search_owned_claims": result = { page: await this.port.searchOwnedClaims({ ...context, query: ownedClaimSearchQuery(call.arguments) }) }; break;
      case "find_owned_claim_by_number": result = { claim: await this.port.findOwnedClaimByNumber({ ...context, claimNumber: requiredString(call.arguments, "claimNumber") }) }; break;
      case "update_claim_fields": result = { claim: await this.port.updateClaimFields({ ...context, claimId: requiredString(call.arguments, "claimId"), version: requiredNumber(call.arguments, "version"), fields: claimFieldPatch(call.arguments) }) }; break;
      case "get_claim_validation": result = { validation: await this.port.getClaimValidation({ ...context, claimId: requiredString(call.arguments, "claimId") }) }; break;
      case "get_owned_claim_progress": assertOnlyFields(call.arguments, ["claimId"]); result = { progress: await this.port.getOwnedClaimProgress({ ...context, claimId: requiredString(call.arguments, "claimId") }) }; break;
      case "request_submission_confirmation": result = { confirmation: await this.port.requestSubmissionConfirmation({ ...context, claimId: requiredString(call.arguments, "claimId"), version: requiredNumber(call.arguments, "version") }) }; break;
      case "submit_claim": result = { submission: await this.port.submitClaim({ ...context, claimId: requiredString(call.arguments, "claimId"), confirmationToken: requiredString(call.arguments, "confirmationToken") }) }; break;
      }
      await this.results.saveCompleted({ toolCallId: call.toolCallId, conversationId: call.conversationId, toolName: call.name, result });
      return result;
    } catch (error) {
      this.onFailure?.(error, call);
      throw error;
    }
  }
}

function ownedClaimSearchQuery(args: Record<string, unknown>): OwnedClaimSearchQuery {
  const allowed = new Set(["status", "createdFrom", "createdBefore", "purposeContains", "expenseCategory", "minRequestedAmountCent", "maxRequestedAmountCent", "sort", "limit", "cursor", "countOnly"]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`invalid search field ${key}`);
  const limit = args.limit === undefined ? 5 : args.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error("invalid search limit");
  const query: OwnedClaimSearchQuery = { limit: limit as number };
  if (args.status !== undefined) {
    if (args.status !== "DRAFT" && args.status !== "SUBMITTED") throw new Error("invalid search status");
    query.status = args.status;
  }
  for (const field of ["createdFrom", "createdBefore"] as const) {
    if (args[field] === undefined) continue;
    if (typeof args[field] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args[field]) || Number.isNaN(Date.parse(args[field]))) throw new Error(`invalid ${field}`);
    query[field] = args[field];
  }
  if (query.createdFrom && query.createdBefore && query.createdFrom >= query.createdBefore) throw new Error("invalid date range");
  for (const field of ["purposeContains", "expenseCategory", "cursor"] as const) {
    if (args[field] === undefined) continue;
    if (typeof args[field] !== "string" || args[field].length > (field === "cursor" ? 1000 : 200)) throw new Error(`invalid ${field}`);
    query[field] = args[field];
  }
  for (const field of ["minRequestedAmountCent", "maxRequestedAmountCent"] as const) {
    if (args[field] === undefined) continue;
    if (!Number.isSafeInteger(args[field]) || (args[field] as number) < 0) throw new Error(`invalid ${field}`);
    query[field] = args[field] as number;
  }
  if (query.minRequestedAmountCent !== undefined && query.maxRequestedAmountCent !== undefined && query.minRequestedAmountCent > query.maxRequestedAmountCent) throw new Error("invalid amount range");
  if (args.sort !== undefined) {
    if (!["created_desc", "created_asc", "amount_desc", "amount_asc"].includes(String(args.sort))) throw new Error("invalid sort");
    query.sort = args.sort as OwnedClaimSearchQuery["sort"];
  }
  if (args.countOnly !== undefined) {
    if (typeof args.countOnly !== "boolean") throw new Error("invalid countOnly");
    query.countOnly = args.countOnly;
  }
  return query;
}

function claimFieldPatch(args: Record<string, unknown>): ClaimFieldPatch {
  const fields: ClaimFieldPatch = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "claimId" || key === "version") continue;
    if (key === "participants" && Array.isArray(value) && value.every((item) => typeof item === "string")) { fields.participants = value; continue; }
    if ((key === "purpose" || key === "expenseCategory" || key === "projectCode") && typeof value === "string") { fields[key] = value; continue; }
    throw new Error(`invalid claim field ${key}`);
  }
  if (!Object.keys(fields).length) throw new Error("no claim fields supplied");
  return fields;
}

function assertContext(value: ToolCallContext) {
  if (!value.actorEmployeeId || !value.actorRole || !value.conversationId || !value.toolCallId || !value.idempotencyKey) throw new Error("tool call context is incomplete");
}
function requiredString(value: Record<string, unknown>, field: string) {
  if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`invalid ${field}`);
  return value[field];
}
function optionalPurpose(value: Record<string, unknown>): string {
  if (value.purpose === undefined) return "";
  if (typeof value.purpose !== "string") throw new Error("invalid purpose");
  return value.purpose;
}
function requiredNumber(value: Record<string, unknown>, field: string) {
  if (typeof value[field] !== "number" || !Number.isFinite(value[field])) throw new Error(`invalid ${field}`);
  return value[field];
}

function assertOnlyFields(value: Record<string, unknown>, fields: readonly string[]) {
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`invalid field ${key}`);
}
