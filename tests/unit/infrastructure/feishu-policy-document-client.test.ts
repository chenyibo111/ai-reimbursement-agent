import { expect, it, vi } from "vitest";

import { createFeishuPolicyDocumentClient } from "@/src/infrastructure/feishu/feishu-policy-document-client";

it("reads a raw-content-only docx response with the registered source title", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: "t-secret", expire: 7200 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { content: "# 标题\n住宿上限 500 元" } }), { status: 200 }));
  const client = createFeishuPolicyDocumentClient({ appId: "app-id", appSecret: "app-secret", fetch: fetchImpl });

  await expect(client.read({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789", title: "差旅制度" })).resolves.toEqual({
    title: "差旅制度",
    revision: "9e3ee49e6a905f2670478e29250a6aaffdd9bb33ee6b6808c2c5e91130f3f22a",
    canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789",
    blocks: [{ kind: "heading", text: "标题" }, { kind: "paragraph", text: "住宿上限 500 元" }],
  });
  expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://open.feishu.cn/open-apis/docx/v1/documents/ABCdef0123456789/raw_content");
  expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer t-secret");
  expect(fetchImpl.mock.calls[1]?.[1]?.body).toBeUndefined();
});

it("maps provider errors to safe categories without exposing response content", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response("credential or document detail", { status: 403 }));
  const client = createFeishuPolicyDocumentClient({ appId: "app-id", appSecret: "app-secret", fetch: fetchImpl });

  await expect(client.read({ type: "FEISHU_DOCX", token: "ABCdef0123456789", canonicalUrl: "https://acme.feishu.cn/docx/ABCdef0123456789" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
