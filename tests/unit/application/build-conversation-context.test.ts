import { expect, it } from "vitest";

import { buildConversationContext } from "@/src/application/build-conversation-context";

it("keeps the newest messages within budget and retains the authoritative Intake state", () => {
  const context = buildConversationContext({
    conversation: { summary: "早期摘要：报销事由是旧值。", summaryThroughSequence: 4 },
    messages: [
      { sequence: 5, role: "USER", channel: "WEB", text: "早期补充说明" },
      { sequence: 6, role: "ASSISTANT", channel: "WEB", text: "请继续补充" },
      { sequence: 7, role: "USER", channel: "FEISHU", text: "最新说明" },
    ],
    intake: {
      status: "COLLECTING",
      claimId: "claim-private-id",
      collectedFields: { purpose: "客户拜访" },
      pendingFields: ["participants"],
    },
    policyCitations: [{ title: "差旅制度", headingPath: ["住宿"], excerpt: "住宿费用上限为每晚 500 元。", score: 0.91, url: "https://private.example/doc" }],
    budgets: { summaryChars: 100, messageChars: 4, intakeChars: 200, policyChars: 200 },
  });

  expect(context.summary).toEqual({ text: "早期摘要：报销事由是旧值。", throughSequence: 4 });
  expect(context.messages).toEqual([{ sequence: 7, role: "USER", channel: "FEISHU", text: "最新说明" }]);
  expect(context.intake).toMatchObject({ collectedFields: { purpose: "客户拜访" }, pendingFields: ["participants"] });
  expect("claimId" in (context.intake ?? {})).toBe(false);
  expect(context.policyCitations).toEqual([{ title: "差旅制度", headingPath: ["住宿"], excerpt: "住宿费用上限为每晚 500 元。", score: 0.91 }]);
  expect(JSON.stringify(context)).not.toContain("claim-private-id");
  expect(JSON.stringify(context)).not.toContain("private.example");
});

it("uses deterministic limits and does not let a summary replace Intake facts", () => {
  const context = buildConversationContext({
    conversation: { summary: "旧的报销事由：会议。", summaryThroughSequence: 10 },
    messages: [
      { sequence: 11, role: "USER", channel: "WEB", text: "a".repeat(8) },
      { sequence: 12, role: "USER", channel: "WEB", text: "b".repeat(8) },
    ],
    intake: { status: "READY_TO_SUBMIT", claimId: null, collectedFields: { purpose: "客户拜访" }, pendingFields: [] },
    policyCitations: [],
    budgets: { summaryChars: 4, messageChars: 8, intakeChars: 200, policyChars: 100 },
  });

  expect(context.summary.text).toBe("旧的报销");
  expect(context.messages).toEqual([{ sequence: 12, role: "USER", channel: "WEB", text: "b".repeat(8) }]);
  expect(context.intake?.collectedFields).toEqual({ purpose: "客户拜访" });
});
