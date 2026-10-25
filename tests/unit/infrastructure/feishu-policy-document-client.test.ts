import { expect, it, vi } from "vitest";

import { createFeishuPolicyDocumentClient } from "@/src/infrastructure/feishu/feishu-policy-document-client";

it("reads paginated structured blocks so headings and the last rate survive", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("/tenant_access_token/internal")) return new Response(JSON.stringify({ tenant_access_token: "t-secret", expire: 7200 }), { status: 200 });
    if (url.includes("page_token=next")) return new Response(JSON.stringify({ code: 0, data: { items: [
      { block_id: "b-4", parent_id: "root", bullet: { elements: [{ text_run: { content: "其他城市 400 元/间" } }] } },
    ], has_more: false } }), { status: 200 });
    if (url.includes("/blocks")) return new Response(JSON.stringify({ code: 0, data: { items: [
      { block_id: "root", page: { elements: [] }, children: ["b-1", "b-2", "b-3", "b-4"] },
      { block_id: "b-1", parent_id: "root", heading2: { elements: [{ text_run: { content: "住宿费" } }] } },
      { block_id: "b-2", parent_id: "root", bullet: { elements: [{ text_run: { content: "北京、上海 600 元/间" } }] } },
      { block_id: "b-3", parent_id: "root", bullet: { elements: [{ text_run: { content: "广州等城市 500 元/间" } }] } },
    ], has_more: true, page_token: "next" } }), { status: 200 });
    return new Response("unexpected endpoint", { status: 404 });
  });
  const client = createFeishuPolicyDocumentClient({ appId: "app-id", appSecret: "app-secret", fetch: fetchImpl as typeof fetch });

  const document = await client.read({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789", title: "差旅制度" });

  expect(document.blocks).toEqual([
    { kind: "heading", text: "住宿费", level: 2, sourceBlockId: "b-1" },
    { kind: "list_item", text: "北京、上海 600 元/间", sourceBlockId: "b-2" },
    { kind: "list_item", text: "广州等城市 500 元/间", sourceBlockId: "b-3" },
    { kind: "list_item", text: "其他城市 400 元/间", sourceBlockId: "b-4" },
  ]);
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("page_token=next"))).toBe(true);
});

it("keeps a Docx rate table as ordered complete rows", async () => {
  const items = [
    { block_id: "root", page: {}, children: ["h", "t"] },
    { block_id: "h", heading2: { elements: [{ text_run: { content: "住宿费" } }] } },
    { block_id: "t", table: { property: { row_size: 2, column_size: 2 } }, children: ["c1", "c2", "c3", "c4"] },
    ...["城市", "上限", "北京上海", "600 元"].map((text, index) => ({ block_id: `c${index + 1}`, table_cell: {}, children: [`v${index + 1}`], parent_id: "t", text })),
    ...["城市", "上限", "北京上海", "600 元"].map((text, index) => ({ block_id: `v${index + 1}`, text: { elements: [{ text_run: { content: text } }] }, parent_id: `c${index + 1}` })),
  ];
  const fetchImpl = vi.fn(async (url: string) => url.endsWith("/tenant_access_token/internal")
    ? new Response(JSON.stringify({ tenant_access_token: "t-secret", expire: 7200 }), { status: 200 })
    : new Response(JSON.stringify({ code: 0, data: { items, has_more: false } }), { status: 200 }));
  const client = createFeishuPolicyDocumentClient({ appId: "app-id", appSecret: "app-secret", fetch: fetchImpl as typeof fetch });
  const document = await client.read({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789" });
  expect(document.blocks).toEqual([
    { kind: "heading", text: "住宿费", level: 2, sourceBlockId: "h" },
    { kind: "table_row", text: "城市 | 上限", sourceBlockId: "t" },
    { kind: "table_row", text: "北京上海 | 600 元", sourceBlockId: "t" },
  ]);
});

it("reads a raw-content-only docx response with the registered source title", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: "t-secret", expire: 7200 }), { status: 200 }))
    .mockResolvedValueOnce(new Response("not supported", { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { content: "# 标题\n住宿上限 500 元" } }), { status: 200 }));
  const client = createFeishuPolicyDocumentClient({ appId: "app-id", appSecret: "app-secret", fetch: fetchImpl });

  await expect(client.read({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789", title: "差旅制度" })).resolves.toEqual({
    title: "差旅制度",
    revision: "9e3ee49e6a905f2670478e29250a6aaffdd9bb33ee6b6808c2c5e91130f3f22a",
    canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789",
    blocks: [{ kind: "heading", text: "标题", level: 1 }, { kind: "paragraph", text: "住宿上限 500 元" }],
  });
  expect(fetchImpl.mock.calls[2]?.[0]).toBe("https://open.feishu.cn/open-apis/docx/v1/documents/ABCdef0123456789/raw_content");
  expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer t-secret");
  expect(fetchImpl.mock.calls[1]?.[1]?.body).toBeUndefined();
});

it("maps provider errors to safe categories without exposing response content", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response("credential or document detail", { status: 403 }));
  const client = createFeishuPolicyDocumentClient({ appId: "app-id", appSecret: "app-secret", fetch: fetchImpl });

  await expect(client.read({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
