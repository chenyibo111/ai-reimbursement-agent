import { describe, expect, it } from "vitest";

import { parsePolicySourceUrl } from "@/src/domain/policy-source";

describe("parsePolicySourceUrl", () => {
  it.each([
    ["https://acme.feishu.cn/docx/ABCdef0123456789", { type: "FEISHU_DOCX", token: "ABCdef0123456789" }],
    ["https://acme.feishu.cn/wiki/ABCdef0123456789", { type: "FEISHU_WIKI", token: "ABCdef0123456789" }],
  ])("accepts an explicit Feishu %s source", (url, expected) => {
    expect(parsePolicySourceUrl(url)).toMatchObject(expected);
  });

  it.each([
    "https://evil.example/docx/ABCdef0123456789",
    "https://acme.feishu.cn/docx/ABCdef0123456789?share=1",
    "https://acme.feishu.cn/wiki/ABCdef0123456789#heading",
    "https://user@acme.feishu.cn/docx/ABCdef0123456789",
    "https://acme.feishu.cn:8443/docx/ABCdef0123456789",
    "https://acme.feishu.cn/docx/short",
  ])("rejects an unsafe or unsupported source URL: %s", (url) => {
    expect(() => parsePolicySourceUrl(url)).toThrow("不支持的飞书政策来源链接");
  });
});
