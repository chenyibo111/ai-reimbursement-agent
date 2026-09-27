import { createHash } from "node:crypto";

import { z } from "zod";

import type { PolicySourceLocator } from "@/src/domain/policy-source";

export type PolicyDocumentBlock = { kind: "heading" | "paragraph"; text: string };
export type ReadPolicyDocument = { title: string; revision: string; canonicalUrl: string; blocks: PolicyDocumentBlock[] };
export type FeishuPolicyDocumentClient = { read(locator: PolicySourceLocator): Promise<ReadPolicyDocument> };

export class FeishuPolicyDocumentClientError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "UNAUTHORIZED" | "RESOURCE_NOT_FOUND" | "INVALID_RESPONSE") {
    super(`feishu policy document client ${code}`);
  }
}

export function createFeishuPolicyDocumentClient(config: { appId: string; appSecret: string; fetch?: typeof fetch; baseUrl?: string }): FeishuPolicyDocumentClient {
  const fetcher = config.fetch ?? fetch;
  const baseUrl = (config.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function tenantToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    const response = await safeFetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    if (!response.ok) throw providerError(response.status);
    const payload = await json(response);
    const parsed = z.object({ code: z.union([z.literal(0), z.literal("0")]).optional(), tenant_access_token: z.string().min(1), expire: z.number().positive().default(7200) }).safeParse(payload);
    if (!response.ok || !parsed.success) throw providerError(response.status);
    cachedToken = { value: parsed.data.tenant_access_token, expiresAt: Date.now() + Math.max(60, parsed.data.expire - 60) * 1000 };
    return cachedToken.value;
  }
  async function authorized(path: string) {
    const token = await tenantToken();
    return safeFetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }
  async function rawDocument(token: string) {
    const response = await authorized(`/open-apis/docx/v1/documents/${encodeURIComponent(token)}/raw_content`);
    if (!response.ok) throw providerError(response.status);
    const payload = await json(response);
    const parsed = z.object({ code: z.union([z.literal(0), z.literal("0")]).optional(), data: z.object({ content: z.string() }) }).safeParse(payload);
    if (!response.ok || !parsed.success) throw providerError(response.status);
    return parsed.data.data;
  }
  return {
    async read(locator) {
      let documentToken = locator.token;
      if (locator.type === "FEISHU_WIKI") {
        const response = await authorized(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(locator.token)}`);
        if (!response.ok) throw providerError(response.status);
        const payload = await json(response);
        const parsed = z.object({ code: z.union([z.literal(0), z.literal("0")]).optional(), data: z.object({ node: z.object({ obj_type: z.literal("docx"), obj_token: z.string().min(1) }) }) }).safeParse(payload);
        if (!response.ok || !parsed.success) throw providerError(response.status);
        documentToken = parsed.data.data.node.obj_token;
      }
      const document = await rawDocument(documentToken);
      return {
        title: locator.title?.trim() || "未命名政策来源",
        revision: createHash("sha256").update(document.content).digest("hex"),
        canonicalUrl: locator.canonicalUrl,
        blocks: blocks(document.content),
      };
    },
  };

  async function safeFetch(url: string, init: RequestInit) {
    try { return await fetcher(url, init); } catch { throw new FeishuPolicyDocumentClientError("UNAVAILABLE"); }
  }
}

function blocks(content: string): PolicyDocumentBlock[] {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20_000).map((line) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    return heading ? { kind: "heading" as const, text: heading[2]!.trim() } : { kind: "paragraph" as const, text: line };
  });
}
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE"); } }
function providerError(status: number) { return new FeishuPolicyDocumentClientError(status === 401 || status === 403 ? "UNAUTHORIZED" : status === 404 ? "RESOURCE_NOT_FOUND" : status >= 500 || status === 0 ? "UNAVAILABLE" : "INVALID_RESPONSE"); }
