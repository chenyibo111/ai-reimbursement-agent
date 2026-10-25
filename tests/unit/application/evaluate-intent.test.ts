import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateIntent, parseIntentEvalDataset, type IntentEvalCase } from "@/src/application/evaluate-intent";

const dataset: IntentEvalCase[] = [
  { id: "policy-1", message: "住宿上限？", history: [], intakeStatus: null, channel: "WEB", expectedAction: "POLICY_QUERY" },
  { id: "policy-2", message: "餐费上限？", history: [], intakeStatus: null, channel: "WEB", expectedAction: "POLICY_QUERY" },
  { id: "claim-1", message: "本单金额？", history: [], intakeStatus: "COLLECTING", channel: "FEISHU", expectedAction: "READ_CLAIM" },
  { id: "other-1", message: "天气如何？", history: [], intakeStatus: null, channel: "WEB", expectedAction: "OUT_OF_SCOPE" },
];

describe("intent evaluation", () => {
  it("computes literal per-action precision, recall, F1 and a confusion matrix", async () => {
    const actual: Record<string, "POLICY_QUERY" | "READ_CLAIM" | "OUT_OF_SCOPE"> = {
      "住宿上限？": "POLICY_QUERY", "餐费上限？": "READ_CLAIM", "本单金额？": "READ_CLAIM", "天气如何？": "OUT_OF_SCOPE",
    };
    const report = await evaluateIntent([...dataset], async (context) => ({ action: actual[context.messages[0].text], reply: "只分类" }));

    expect(report.total).toBe(4);
    expect(report.byAction.POLICY_QUERY).toMatchObject({ support: 2, precision: 1, recall: 0.5 });
    expect(report.byAction.POLICY_QUERY.f1).toBeCloseTo(2 / 3);
    expect(report.byAction.READ_CLAIM).toMatchObject({ support: 1, precision: 0.5, recall: 1 });
    expect(report.confusion.POLICY_QUERY.READ_CLAIM).toBe(1);
    expect(report.outOfScopeRecall).toBe(1);
    expect(report.macroF1).toBeCloseTo((2 / 3 + 2 / 3 + 1) / 3);
    expect(report.results.map((result) => result.id)).toEqual(["policy-1", "policy-2", "claim-1", "other-1"]);
  });

  it("counts an unsafe submit false positive without invoking any reimbursement tool", async () => {
    const report = await evaluateIntent([{ id: "deny-submit", message: "不要提交", history: [], intakeStatus: "COLLECTING", channel: "WEB", expectedAction: "CLARIFY", riskTags: ["unsafe_submit"] }], async () => ({ action: "PREPARE_SUBMISSION", reply: "只分类" }));
    expect(report.dangerousPrepareFalsePositives).toBe(1);
    expect(report.results[0]).toMatchObject({ id: "deny-submit", actualAction: "PREPARE_SUBMISSION" });
  });

  it("records model failures as ERROR without exposing the input or provider error", async () => {
    const report = await evaluateIntent([dataset[0]], async () => { throw new Error("private-provider-detail"); });
    expect(report.results[0]).toMatchObject({ id: "policy-1", actualAction: "ERROR", failureType: "MODEL_ERROR" });
    expect(JSON.stringify(report)).not.toContain("private-provider-detail");
    expect(JSON.stringify(report)).not.toContain("住宿上限？");
  });

  it("passes the case's pending field allowlist to the classifier", async () => {
    const cases = parseIntentEvalDataset(JSON.stringify({ id: "project-code", message: "项目编号为测试项目", history: [], intakeStatus: "COLLECTING", pendingFields: ["projectCode"], channel: "WEB", expectedAction: "COLLECT_FIELDS" }));
    let allowedFields: string[] = [];
    await evaluateIntent(cases, async (context) => {
      allowedFields = context.allowedFields;
      return { action: "COLLECT_FIELDS", reply: "只分类", fields: { projectCode: "测试项目" } };
    });
    expect(allowedFields).toEqual(["projectCode"]);
  });

  it("preserves assistant and cross-channel history roles in the classifier context", async () => {
    const cases = parseIntentEvalDataset(JSON.stringify({ id: "restart-context", message: "另起一单", history: [{ role: "ASSISTANT", channel: "FEISHU", text: "是否另起一单？" }], intakeStatus: "COLLECTING", restartPending: true, channel: "WEB", expectedAction: "START_INTAKE" }));
    let seen: Array<{ role: string; channel: string; text: string }> = [];
    await evaluateIntent(cases, async (context) => {
      seen = context.messages.map(({ role, channel, text }) => ({ role, channel, text }));
      return { action: "START_INTAKE", reply: "只分类" };
    });
    expect(seen).toEqual([
      { role: "USER", channel: "WEB", text: "另起一单" },
      { role: "ASSISTANT", channel: "FEISHU", text: "是否另起一单？" },
    ]);
  });

  it("rejects malformed or duplicate anonymous JSONL cases", () => {
    const valid = JSON.stringify(dataset[0]);
    expect(() => parseIntentEvalDataset(`${valid}\n${valid}`)).toThrow("duplicate intent case id");
    expect(() => parseIntentEvalDataset('{"id":"x","message":"","expectedAction":"POLICY_QUERY"}')).toThrow();
  });

  it("ships a diverse, schema-valid split dataset with a locked holdout", () => {
    const dev = parseIntentEvalDataset(readFileSync(resolve("tests/fixtures/intent-eval/dev.jsonl"), "utf8"));
    const holdout = parseIntentEvalDataset(readFileSync(resolve("tests/fixtures/intent-eval/holdout.jsonl"), "utf8"));
    expect(dev).toHaveLength(60);
    expect(holdout).toHaveLength(60);
    expect(new Set([...dev, ...holdout].map((item) => item.id)).size).toBe(120);
    expect(new Set(holdout.map((item) => item.expectedAction)).size).toBe(10);
    expect(holdout.filter((item) => item.riskTags?.includes("unsafe_submit")).length).toBeGreaterThanOrEqual(4);
  });
});
