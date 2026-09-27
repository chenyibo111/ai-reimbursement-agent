import { expect, it } from "vitest";

import { splitPolicyDocument } from "@/src/application/split-policy-document";

it("keeps heading boundaries and emits bounded ordered policy chunks", () => {
  const chunks = splitPolicyDocument([
    { kind: "heading", text: "差旅" },
    { kind: "paragraph", text: "住宿上限 500 元。" },
    { kind: "paragraph", text: "交通需保留票据。" },
  ], { maxLength: 20, minLength: 8 });
  expect(chunks).toEqual([
    expect.objectContaining({ headingPath: ["差旅"], content: "住宿上限 500 元。" }),
    expect.objectContaining({ headingPath: ["差旅"], content: "交通需保留票据。" }),
  ]);
});
