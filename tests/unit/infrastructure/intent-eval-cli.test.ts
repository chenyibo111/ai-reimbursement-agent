import { expect, it } from "vitest";

import { checkIntentEvalGate, resolveIntentEvalModelConfig, runIntentEvalCli, shouldFailIntentEvalRun } from "@/scripts/eval-intent";

it("refuses fixture and incomplete providers for a real-model run", () => {
  expect(() => resolveIntentEvalModelConfig({ MODEL_PROVIDER: "fixture" })).toThrow("openai-compatible");
  expect(() => resolveIntentEvalModelConfig({ MODEL_PROVIDER: "openai-compatible" })).toThrow("MODEL_BASE_URL");
});

it("runs only the injected classifier and emits anonymous aggregate results", async () => {
  const output: string[] = [];
  const report = await runIntentEvalCli({
    datasetText: '{"id":"sample-1","message":"住宿上限是多少","history":[],"intakeStatus":null,"channel":"WEB","expectedAction":"POLICY_QUERY"}',
    datasetVersion: "test-v1",
    modelName: "test-model",
    decide: async () => ({ action: "POLICY_QUERY", reply: "只分类" }),
    write: (line) => output.push(line),
  });
  expect(report.total).toBe(1);
  expect(output.join("\n")).toContain("test-v1");
  expect(output.join("\n")).not.toContain("住宿上限是多少");
});

it("supports a bounded smoke run without labeling it as the full holdout", async () => {
  const output: string[] = [];
  const caseText = '{"id":"sample-1","message":"住宿上限是多少","history":[],"intakeStatus":null,"channel":"WEB","expectedAction":"POLICY_QUERY"}';
  const report = await runIntentEvalCli({ datasetText: `${caseText}\n${caseText.replace("sample-1", "sample-2")}`, datasetVersion: "holdout", modelName: "test-model", maxCases: 1, decide: async () => ({ action: "POLICY_QUERY", reply: "ok" }), write: (line) => output.push(line) });
  expect(report.total).toBe(1);
  expect(output.join("\n")).toContain('"sampled":true');
});

it("fails the current holdout gate for a correct action with a wrong write target", async () => {
  const report = await runIntentEvalCli({
    datasetText: '{"id":"target","message":"编辑 BX20261024-0004","history":[],"intakeStatus":null,"channel":"FEISHU","expectedAction":"SELECT_EDIT_CLAIM","expectedDecision":{"claimNumber":"BX20261024-0004"},"riskTags":["wrong_claim"]}',
    datasetVersion: "holdout-v3", modelName: "fixture-model",
    decide: async () => ({ action: "SELECT_EDIT_CLAIM", reply: "ok", claimNumber: "BX20261024-0003" }), write: () => {},
  });
  expect(checkIntentEvalGate(report).passed).toBe(false);
  expect(checkIntentEvalGate(report).reasons).toContain("dangerous_write_target_errors");
});

it("fails the current holdout gate for a wrong read target and recognizes an explicit full-case limit", async () => {
  const output: string[] = [];
  const report = await runIntentEvalCli({
    datasetText: '{"id":"read-target","message":"查询 BX20261024-0004 的进度","history":[],"intakeStatus":null,"channel":"FEISHU","expectedAction":"READ_CLAIM_PROGRESS","expectedDecision":{"claimNumber":"BX20261024-0004"}}',
    datasetVersion: "holdout-v3", modelName: "fixture-model", maxCases: 1,
    decide: async () => ({ action: "READ_CLAIM_PROGRESS", reply: "ok", claimNumber: "BX20261024-0003" }), write: (line) => output.push(line),
  });
  expect(checkIntentEvalGate(report).reasons).toContain("target_reference_errors");
  expect(output.join("\n")).toContain('"sampled":false');
  expect(output.join("\n")).toContain('"target_reference_errors"');
  expect(shouldFailIntentEvalRun("holdout-v3", report, 1)).toBe(true);
  expect(shouldFailIntentEvalRun("holdout-v3", report, 2)).toBe(false);
});
