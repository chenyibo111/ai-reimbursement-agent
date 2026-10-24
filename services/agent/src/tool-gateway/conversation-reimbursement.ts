import { ReimbursementToolGateway, type ReimbursementToolName } from "./reimbursement-tools";

export type ConversationReimbursementContext = { actorId: string; actorRole: "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN"; channel: "WEB" | "FEISHU"; conversationId: string; turnId: string };
type Attachment = { filename: string; mimeType: string; bytes: Uint8Array };

/** Adapts persisted conversation actions to the eight audited reimbursement tools. */
export function createConversationReimbursementTools(gateway: ReimbursementToolGateway, fetcher: typeof fetch = fetch, internalStorageEndpoint?: string) {
  const execute = (context: ConversationReimbursementContext, name: ReimbursementToolName, args: Record<string, unknown>) => gateway.execute({
    actorEmployeeId: context.actorId,
    actorRole: context.actorRole,
    channel: context.channel,
    conversationId: context.conversationId,
    toolCallId: `${context.actorId}:${context.conversationId}:${context.turnId}:${name}`,
    idempotencyKey: `${context.actorId}:${context.conversationId}:${context.turnId}:${name}`,
    name,
    arguments: args,
  });
  return {
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
