import { createHmac } from "node:crypto";

import type { ClaimFieldPatch, ClaimSnapshot, ReimbursementPort, ReceiptSnapshot, ToolCallContext, ValidationSnapshot } from "../ports/reimbursement-port";

type ApiClientOptions = {
  baseUrl: string;
  serviceKey: string;
  signingSecret: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  randomId?: () => string;
};

export class ReimbursementApiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ReimbursementApiHttpError";
  }
}

export class ReimbursementApiClient implements ReimbursementPort {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly baseUrl: string;
  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
  }

  createClaimDraft(input: ToolCallContext & { purpose: string }) { return this.request<ClaimSnapshot>(input, "/api/v1/claims", "POST", { purpose: input.purpose }); }
  createUploadSession(input: ToolCallContext & { claimId: string; filename: string; contentType: string; sizeBytes: number }) { return this.request<{ receiptId: string; uploadUrl: string }>(input, `/api/v1/claims/${encodeURIComponent(input.claimId)}/uploads`, "POST", { filename: input.filename, contentType: input.contentType, sizeBytes: input.sizeBytes }); }
  finalizeReceiptUpload(input: ToolCallContext & { claimId: string; receiptId: string }) { return this.request<{ receiptId: string; status: string }>(input, `/api/v1/claims/${encodeURIComponent(input.claimId)}/receipts`, "POST", { receiptId: input.receiptId }); }
  async getClaimWorkbench(input: ToolCallContext & { claimId: string }) {
    const path = `/api/v1/claims/${encodeURIComponent(input.claimId)}`;
    const [claim, receipts] = await Promise.all([this.request<ClaimSnapshot>(input, path, "GET"), this.request<{ items: ReceiptSnapshot[] }>(input, `${path}/receipts`, "GET")]);
    return { claim, receipts: receipts.items };
  }
  async listOwnedClaims(input: ToolCallContext & { limit: number }) {
    const response = await this.request<{ items: ClaimSnapshot[] }>(input, `/api/v1/claims?limit=${input.limit}`, "GET");
    if (!Array.isArray(response.items)) throw new Error("invalid owned claim list");
    return response.items.map(assertClaimSnapshot);
  }
  async findOwnedClaimByNumber(input: ToolCallContext & { claimNumber: string }) {
    const response = await this.request<{ items: ClaimSnapshot[] }>(input, `/api/v1/claims?claimNumber=${encodeURIComponent(input.claimNumber)}`, "GET");
    if (!Array.isArray(response.items) || response.items.length > 1) throw new Error("invalid claim lookup response");
    return response.items.length ? assertClaimSnapshot(response.items[0]) : null;
  }
  updateClaimFields(input: ToolCallContext & { claimId: string; version: number; fields: ClaimFieldPatch }) { return this.request<ClaimSnapshot>(input, `/api/v1/claims/${encodeURIComponent(input.claimId)}`, "PATCH", { version: input.version, ...input.fields }); }
  getClaimValidation(input: ToolCallContext & { claimId: string }) { return this.request<ValidationSnapshot>(input, `/api/v1/claims/${encodeURIComponent(input.claimId)}/validation`, "GET"); }
  requestSubmissionConfirmation(input: ToolCallContext & { claimId: string; version: number }) { return this.request<{ confirmationToken: string; claimId: string; claimVersion: number }>(input, `/api/v1/claims/${encodeURIComponent(input.claimId)}/submission-requests`, "POST", { version: input.version }); }
  submitClaim(input: ToolCallContext & { claimId: string; confirmationToken: string }) { return this.request<{ claimId: string; submissionNumber: string }>(input, `/api/v1/claims/${encodeURIComponent(input.claimId)}/submit`, "POST", { confirmationToken: input.confirmationToken }); }

  private async request<T>(context: ToolCallContext, path: string, method: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, { method, headers: { "Accept": "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), "Authorization": `Bearer ${this.token(context)}`, "X-Agent-Service-Key": this.options.serviceKey, "Idempotency-Key": context.idempotencyKey }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ReimbursementApiHttpError(typeof payload.message === "string" ? payload.message : "报销服务暂不可用", response.status, typeof payload.code === "string" ? payload.code : undefined);
    return payload as T;
  }

  private token(context: ToolCallContext) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const iat = Math.floor(this.now().getTime() / 1000);
    const payload = Buffer.from(JSON.stringify({ sub: context.actorEmployeeId, role: context.actorRole, aud: "reimbursement-api", iat, exp: iat + 15 * 60, jti: this.randomId(), channel: "agent", source_channel: context.channel, conversation_id: context.conversationId, tool_call_id: context.toolCallId })).toString("base64url");
    const signed = `${header}.${payload}`;
    return `${signed}.${createHmac("sha256", this.options.signingSecret).update(signed).digest("base64url")}`;
  }
}

function assertClaimSnapshot(value: ClaimSnapshot): ClaimSnapshot {
  if (!value || typeof value.id !== "string" || typeof value.claimNumber !== "string" || typeof value.version !== "number" || typeof value.status !== "string" || !Array.isArray(value.participants) || typeof value.expenseCategory !== "string" || typeof value.projectCode !== "string") throw new Error("invalid claim response");
  return value;
}
