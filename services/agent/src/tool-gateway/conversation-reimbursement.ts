import { ReimbursementToolGateway, type ReimbursementToolName } from "./reimbursement-tools";
import { ReimbursementApiHttpError } from "../adapters/reimbursement-api-client";
import type { ClaimFieldPatch, ClaimSnapshot, OwnedClaimSearchPage, OwnedClaimSearchQuery, ReceiptSnapshot, ValidationSnapshot } from "../ports/reimbursement-port";

export type ConversationReimbursementContext = { actorId: string; actorRole: "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN"; channel: "WEB" | "FEISHU"; conversationId: string; turnId: string };
type Attachment = { filename: string; mimeType: string; bytes: Uint8Array };

/** Adapts persisted conversation actions to the eight audited reimbursement tools. */
export function createConversationReimbursementTools(gateway: ReimbursementToolGateway, fetcher: typeof fetch = fetch, internalStorageEndpoint?: string) {
  const execute = (context: ConversationReimbursementContext, name: ReimbursementToolName, args: Record<string, unknown>, operationKey: string = name) => gateway.execute({
    actorEmployeeId: context.actorId,
    actorRole: context.actorRole,
    channel: context.channel,
    conversationId: context.conversationId,
    toolCallId: `${context.actorId}:${context.conversationId}:${context.turnId}:${operationKey}`,
    idempotencyKey: `${context.actorId}:${context.conversationId}:${context.turnId}:${operationKey}`,
    name,
    arguments: args,
  });
  return {
    async searchOwnedClaims(context: ConversationReimbursementContext, query: OwnedClaimSearchQuery): Promise<OwnedClaimSearchPage> {
      return (await execute(context, "search_owned_claims", query, `search_owned_claims:${JSON.stringify(query)}`)).page as OwnedClaimSearchPage;
    },
    async listOwnedClaims(context: ConversationReimbursementContext, limit: number): Promise<ClaimSnapshot[]> {
      return (await execute(context, "list_owned_claims", { limit })).claims as ClaimSnapshot[];
    },
    async findOwnedClaimByNumber(context: ConversationReimbursementContext, claimNumber: string): Promise<ClaimSnapshot | null> {
      return (await execute(context, "find_owned_claim_by_number", { claimNumber })).claim as ClaimSnapshot | null;
    },
    async updateFields(context: ConversationReimbursementContext, claimId: string, fields: ClaimFieldPatch): Promise<ClaimSnapshot> {
      const before = (await execute(context, "get_claim_workbench", { claimId }, "fields.pre-read")).workbench as { claim: ClaimSnapshot };
      try {
        await execute(context, "update_claim_fields", { claimId, version: before.claim.version, ...fields }, "fields.patch");
      } catch (error) {
        if (!(error instanceof ReimbursementApiHttpError) || error.code !== "VERSION_CONFLICT") throw error;
        const current = (await execute(context, "get_claim_workbench", { claimId }, "fields.conflict-read")).workbench as { claim: ClaimSnapshot };
        if (!Object.entries(fields).every(([name, value]) => JSON.stringify(current.claim[name as keyof ClaimSnapshot]) === JSON.stringify(value))) throw error;
        return current.claim;
      }
      const after = (await execute(context, "get_claim_workbench", { claimId }, "fields.post-read")).workbench as { claim: ClaimSnapshot };
      return after.claim;
    },
    async readWorkbench(context: ConversationReimbursementContext, claimId: string) {
      return (await execute(context, "get_claim_workbench", { claimId }, `get_claim_workbench:${claimId}`)).workbench as { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] };
    },
    async readValidation(context: ConversationReimbursementContext, claimId: string) {
      return (await execute(context, "get_claim_validation", { claimId })).validation as ValidationSnapshot;
    },
    async prepareSubmission(context: ConversationReimbursementContext, claimId: string) {
      const workbench = (await execute(context, "get_claim_workbench", { claimId })).workbench as { claim: ClaimSnapshot; receipts: ReceiptSnapshot[] };
      const confirmation = (await execute(context, "request_submission_confirmation", { claimId, version: workbench.claim.version })).confirmation as { confirmationToken: string; claimId: string; claimVersion: number };
      return { ...confirmation, workbench };
    },
    async createClaim(context: ConversationReimbursementContext, purpose?: string) {
      const result = await execute(context, "create_claim_draft", { purpose: purpose?.trim() ?? "" });
      return result.claim as { id: string; version: number };
    },
    async uploadReceipt(context: ConversationReimbursementContext, claimId: string, attachment: Attachment) {
      const session = (await execute(context, "create_upload_session", { claimId, filename: attachment.filename, contentType: attachment.mimeType, sizeBytes: attachment.bytes.byteLength })).upload as { receiptId: string; uploadUrl: string };
      const uploadTarget = internalUploadTarget(session.uploadUrl, internalStorageEndpoint);
      const upload = await fetcher(uploadTarget.url, { method: "PUT", headers: { "Content-Type": attachment.mimeType, ...uploadTarget.headers }, body: attachment.bytes as unknown as BodyInit, signal: AbortSignal.timeout(15_000) });
      if (!upload.ok) throw new Error("receipt upload failed");
      const result = await execute(context, "finalize_receipt_upload", { claimId, receiptId: session.receiptId });
      return result.receipt as { receiptId: string; status: string };
    },
    async updatePurpose(context: ConversationReimbursementContext, claimId: string, purpose: string) {
      const workbench = (await execute(context, "get_claim_workbench", { claimId })).workbench as { claim: { version: number } };
      const result = await execute(context, "update_claim_fields", { claimId, version: workbench.claim.version, purpose });
      return result.claim as { version: number };
    },
    async requestSubmission(context: ConversationReimbursementContext, claimId: string) {
      const workbench = (await execute(context, "get_claim_workbench", { claimId })).workbench as { claim: { version: number; purpose: string | null; requestedAmountCent?: number | null; receiptCount?: number } };
      const confirmation = (await execute(context, "request_submission_confirmation", { claimId, version: workbench.claim.version })).confirmation as { confirmationToken: string; claimId: string; claimVersion: number };
      return { ...confirmation, totalAmountCents: workbench.claim.requestedAmountCent ?? null, receiptCount: workbench.claim.receiptCount ?? 0, purpose: workbench.claim.purpose };
    },
    async submit(context: ConversationReimbursementContext, claimId: string, confirmationToken: string) {
      return (await execute(context, "submit_claim", { claimId, confirmationToken })).submission as { submissionNumber: string; claimId: string };
    },
  };
}

function internalUploadTarget(uploadURL: string, internalStorageEndpoint?: string): { url: string; headers: Record<string, string> } {
  if (!internalStorageEndpoint) return { url: uploadURL, headers: {} };
  const signedURL = new URL(uploadURL);
  const internalURL = new URL(internalStorageEndpoint);
  const signedHost = signedURL.host;
  signedURL.protocol = internalURL.protocol;
  signedURL.host = internalURL.host;
  return { url: signedURL.toString(), headers: { Host: signedHost } };
}
