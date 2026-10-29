import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { evaluateAgentWorkflows, parseAgentWorkflowDataset } from "@/src/application/evaluate-agent-workflow";
import { replayAgentWorkflow } from "@/src/application/replay-agent-workflow";

it("replays the complete versioned workflow set through the production orchestration and gateway", async () => {
  const cases = parseAgentWorkflowDataset(await readFile(resolve("tests/fixtures/agent-workflow/workflow-v1.jsonl"), "utf8"));
  const report = await evaluateAgentWorkflows(cases, replayAgentWorkflow, false);
  expect(report.totalCases).toBe(10);
  expect(report.totalTurns).toBe(11);
  expect(report.provenanceCounts).toEqual({ synthetic: 6, self_test: 4, employee_anonymized: 0 });
  expect(report.safetyErrors).toBe(0);
  expect(report.passed).toBe(true);
});
