import { expect, it } from "vitest";

import { splitPolicyDocument } from "@/src/application/split-policy-document";

it("splits a long section by complete lines while retaining a line longer than 500 characters", () => {
  const longRule = `北京、上海：${"审批说明".repeat(130)}最终上限 600 元。`;
  const chunks = splitPolicyDocument([
    { sequence: 0, headingPath: ["差旅", "住宿费"], content: `${longRule}\n其他城市上限 400 元。`, sourceAnchor: "#lodging", complete: true },
  ], { targetLength: 400, maxLength: 800 });
  expect(chunks).toEqual([
    expect.objectContaining({ sectionSequence: 0, sequence: 0, content: longRule, sourceAnchor: "#lodging" }),
    expect.objectContaining({ sectionSequence: 0, sequence: 1, content: "其他城市上限 400 元。" }),
  ]);
  expect(chunks[0]?.content.endsWith("最终上限 600 元。")).toBe(true);
});
