import { expect, it } from "vitest";

import { buildPolicySections } from "@/src/application/build-policy-sections";

it("keeps every lodging rate and exception under one heading without traffic rules", () => {
  const sections = buildPolicySections([
    { kind: "heading", text: "三、差旅费", level: 1, sourceBlockId: "travel" },
    { kind: "heading", text: "交通费", level: 2, sourceBlockId: "transport" },
    { kind: "list_item", text: "飞机原则上经济舱。", sourceBlockId: "air" },
    { kind: "heading", text: "住宿费", level: 2, sourceBlockId: "lodging" },
    { kind: "list_item", text: "北京、上海：每晚不超过 600 元/间。", sourceBlockId: "a" },
    { kind: "list_item", text: "广州、深圳、杭州：每晚不超过 500 元/间。", sourceBlockId: "b" },
    { kind: "list_item", text: "其他城市：每晚不超过 400 元/间。", sourceBlockId: "c" },
    { kind: "list_item", text: "统一安排住宿不再报销。", sourceBlockId: "d" },
    { kind: "heading", text: "出差餐费", level: 2, sourceBlockId: "meals" },
    { kind: "paragraph", text: "按公司规定申请。", sourceBlockId: "e" },
  ]);

  expect(sections).toEqual([
    { sequence: 0, headingPath: ["三、差旅费", "交通费"], content: "飞机原则上经济舱。", sourceAnchor: "#transport", complete: true },
    { sequence: 1, headingPath: ["三、差旅费", "住宿费"], content: "北京、上海：每晚不超过 600 元/间。\n广州、深圳、杭州：每晚不超过 500 元/间。\n其他城市：每晚不超过 400 元/间。\n统一安排住宿不再报销。", sourceAnchor: "#lodging", complete: true },
    { sequence: 2, headingPath: ["三、差旅费", "出差餐费"], content: "按公司规定申请。", sourceAnchor: "#meals", complete: true },
  ]);
});

it("marks a section larger than the answer budget incomplete instead of hiding its tail", () => {
  const tail = "关键审批条件";
  const sections = buildPolicySections([
    { kind: "heading", text: "大型制度章节", level: 1 },
    { kind: "paragraph", text: `${"甲".repeat(8_100)}${tail}` },
  ]);
  expect(sections[0]?.content.endsWith(tail)).toBe(true);
  expect(sections[0]?.complete).toBe(false);
});

it("preserves nested city-tier paths so retrieval can expand their parent chapter", () => {
  const sections = buildPolicySections([
    { kind: "heading", text: "差旅制度", level: 1 },
    { kind: "heading", text: "交通费", level: 2 },
    { kind: "paragraph", text: "经济舱" },
    { kind: "heading", text: "住宿费", level: 2, sourceBlockId: "lodging" },
    { kind: "heading", text: "北京上海", level: 3 },
    { kind: "paragraph", text: "每晚 600 元" },
    { kind: "heading", text: "重点城市", level: 3 },
    { kind: "paragraph", text: "每晚 500 元" },
    { kind: "heading", text: "其他城市", level: 3 },
    { kind: "paragraph", text: "每晚 400 元" },
    { kind: "heading", text: "例外", level: 3 },
    { kind: "paragraph", text: "统一安排住宿不报销" },
  ]);
  expect(sections.map(({ headingPath, content }) => ({ headingPath, content }))).toEqual([
    { headingPath: ["差旅制度", "交通费"], content: "经济舱" },
    { headingPath: ["差旅制度", "住宿费", "北京上海"], content: "每晚 600 元" },
    { headingPath: ["差旅制度", "住宿费", "重点城市"], content: "每晚 500 元" },
    { headingPath: ["差旅制度", "住宿费", "其他城市"], content: "每晚 400 元" },
    { headingPath: ["差旅制度", "住宿费", "例外"], content: "统一安排住宿不报销" },
  ]);
});
