import { ReimbursementToolGateway, type ReimbursementToolName } from "./reimbursement-tools";

type ConversationContext = { actorId: string; conversationId: string; channelMessageId?: string };
type Attachment = { filename: string; mimeType: string; bytes: Uint8Array };

/** Adapts persisted conversation actions to the eight audited reimbursement tools. */
export function createConversationReimbursementTools(gateway: ReimbursementToolGateway, fetcher: typeof fetch = fetch) {
  const execute = (context: ConversationContext, name: ReimbursementToolName, args: Record<string, unknown>) => gateway.execute({
    actorEmployeeId: context.actorId,
    channel: "FEISHU",
    conversationId: context.conversationId,
    toolCallId: `${context.channelMessageId ?? context.conversationId}:${name}`,
    idempotencyKey: `${context.channelMessageId ?? context.conversationId}:${name}`,
    name,
    arguments: args,
  });
  return {
    async createClaim(context: ConversationContext, purpose?: string) {
      const result = await execute(context, "create_claim_draft", { purpose: purpose?.trim() || "待补充报销事由" });
      return result.claim as { id: string; version: number };
    },
    async uploadReceipt(context: ConversationContext, claimId: string, attachment: Attachment) {
      const session = (await execute(context, "create_upload_session", { claimId, filename: attachment.filename, contentType: attachment.mimeType, sizeBytes: attachment.bytes.byteLength })).upload as { receiptId: string; uploadUrl: string };
      const upload = await fetcher(session.uploadUrl, { method: "PUT", headers: { "Content-Type": attachment.mimeType }, body: attachment.bytes as unknown as BodyInit });
      if (!upload.ok) throw new Error("receipt upload failed");
      const result = await execute(context, "finalize_receipt_upload", { claimId, receiptId: session.receiptId });
      return result.receipt as { receiptId: string; status: string };
    },
    async updatePurpose(context: ConversationContext, claimId: string, purpose: string) {
      const workbench = (await execute(context, "get_claim_workbench", { claimId })).workbench as { claim: { version: number } };
      const result = await execute(context, "update_claim_fields", { claimId, version: workbench.claim.version, purpose });
      return result.claim as { version: number };
    },
    async requestSubmission(context: ConversationContext, claimId: string) {
      const workbench = (await execute(context, "get_claim_workbench", { claimId })).workbench as { claim: { version: number } };
      return (await execute(context, "request_submission_confirmation", { claimId, version: workbench.claim.version })).confirmation as { confirmationToken: string; claimId: string; claimVersion: number };
    },
    async submit(context: ConversationContext, claimId: string, confirmationToken: string) {
      return (await execute(context, "submit_claim", { claimId, confirmationToken })).submission as { submissionNumber: string; claimId: string };
    },
  };
}
