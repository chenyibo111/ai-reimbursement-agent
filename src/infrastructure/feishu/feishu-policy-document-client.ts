import { createHash } from "node:crypto";

import { z } from "zod";

import type { PolicySourceLocator } from "@/src/domain/policy-source";

export type PolicyDocumentBlock = { kind: "heading" | "paragraph" | "list_item" | "table_row"; text: string; level?: number; sourceBlockId?: string };
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
  async function structuredDocument(token: string): Promise<PolicyDocumentBlock[] | null> {
    const items: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    const visited = new Set<string>();
    do {
      const path = `/open-apis/docx/v1/documents/${encodeURIComponent(token)}/blocks?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`;
      const response = await authorized(path);
      if (response.status === 404) return null;
      if (!response.ok) throw providerError(response.status);
      const parsed = z.object({ code: z.union([z.literal(0), z.literal("0")]), data: z.object({ items: z.array(z.record(z.string(), z.unknown())), has_more: z.boolean().default(false), page_token: z.string().optional() }) }).safeParse(await json(response));
      if (!parsed.success) throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE");
      items.push(...parsed.data.data.items);
      if (items.length > 20_000) throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE");
      pageToken = parsed.data.data.has_more ? parsed.data.data.page_token : undefined;
      if (parsed.data.data.has_more && (!pageToken || visited.has(pageToken))) throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE");
      if (pageToken) visited.add(pageToken);
    } while (pageToken);
    return structuredBlocks(items);
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
      const structured = await structuredDocument(documentToken);
      const document = structured === null ? await rawDocument(documentToken) : null;
      const extracted = structured ?? blocks(document!.content);
      return {
        title: locator.title?.trim() || "未命名政策来源",
        revision: createHash("sha256").update(structured === null ? document!.content : JSON.stringify(extracted)).digest("hex"),
        canonicalUrl: locator.canonicalUrl,
        blocks: extracted,
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
    return heading ? { kind: "heading" as const, text: heading[2]!.trim(), level: heading[1]!.length } : { kind: "paragraph" as const, text: line };
  });
}

function structuredBlocks(items: Array<Record<string, unknown>>): PolicyDocumentBlock[] {
  const byId = new Map(items.map((item) => [String(item.block_id ?? ""), item]));
  const root = items.find((item) => item.page && Array.isArray(item.children));
  const ordered: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  function visit(item: Record<string, unknown>) {
    const id = String(item.block_id ?? "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    ordered.push(item);
    for (const childId of Array.isArray(item.children) ? item.children : []) {
      const child = byId.get(String(childId));
      if (child) visit(child);
    }
  }
  if (root) visit(root);
  for (const item of items) visit(item);
  const result: PolicyDocumentBlock[] = [];
  const consumed = new Set<string>();
  function descendantText(item: Record<string, unknown>): string {
    const own = ["text", "bullet", "ordered", ...Array.from({ length: 9 }, (_, index) => `heading${index + 1}`)]
      .map((key) => item[key] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined)
      .flatMap((body) => body?.elements?.map((element) => element.text_run?.content ?? "") ?? []).join("");
    const nested = (Array.isArray(item.children) ? item.children : [])
      .map((id) => byId.get(String(id))).filter((child): child is Record<string, unknown> => Boolean(child));
    return [own, ...nested.map(descendantText)].filter(Boolean).join(" ").trim();
  }
  function consumeChildren(item: Record<string, unknown>) {
    for (const childId of Array.isArray(item.children) ? item.children : []) {
      const id = String(childId);
      consumed.add(id);
      const child = byId.get(id);
      if (child) consumeChildren(child);
    }
  }
  for (const item of ordered) {
    const id = String(item.block_id ?? "");
    if (consumed.has(id)) continue;
    if (item.table) {
      const table = item.table as { property?: { column_size?: number } };
      const columns = table.property?.column_size;
      const cellIds = Array.isArray(item.children) ? item.children : [];
      if (!columns || !Number.isInteger(columns) || columns < 1 || cellIds.length % columns !== 0) throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE");
      for (let start = 0; start < cellIds.length; start += columns) {
        const cells = cellIds.slice(start, start + columns).map((cellId) => byId.get(String(cellId)));
        if (cells.some((cell) => !cell)) throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE");
        result.push({ kind: "table_row", text: cells.map((cell) => descendantText(cell!)).join(" | "), sourceBlockId: id });
      }
      consumeChildren(item);
      continue;
    }
    const heading = Array.from({ length: 9 }, (_, index) => `heading${index + 1}`).find((key) => item[key]);
    const key = heading ?? (["text", "bullet", "ordered"].find((candidate) => item[candidate]));
    if (!key) continue;
    const body = item[key] as { elements?: Array<{ text_run?: { content?: string }; mention_doc?: { title?: string } }> };
    const text = body.elements?.map((element) => element.text_run?.content ?? element.mention_doc?.title ?? "").join("").trim() ?? "";
    if (!text) continue;
    result.push({ kind: heading ? "heading" : key === "bullet" || key === "ordered" ? "list_item" : "paragraph", text, ...(heading ? { level: Number(heading.slice(7)) } : {}), sourceBlockId: id });
  }
  return result;
}
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { throw new FeishuPolicyDocumentClientError("INVALID_RESPONSE"); } }
function providerError(status: number) { return new FeishuPolicyDocumentClientError(status === 401 || status === 403 ? "UNAUTHORIZED" : status === 404 ? "RESOURCE_NOT_FOUND" : status >= 500 || status === 0 ? "UNAVAILABLE" : "INVALID_RESPONSE"); }
