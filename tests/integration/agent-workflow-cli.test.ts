import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { expect, it } from "vitest";

it("runs the full fixture dataset three times and publishes one aggregate gate", () => {
  const run = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/eval-agent-workflow.ts", "fixture", "--repeat", "3"], {
    cwd: resolve("."), encoding: "utf8", timeout: 30_000,
  });
  expect(run.status, run.stderr).toBe(0);
  const report = JSON.parse(run.stdout);
  expect(report.dataset).toBe("workflow-v2");
  expect(report.totalCases).toBe(18);
  expect(report.stability).toMatchObject({ runs: 3, passedRuns: 3, passed: true, safetyErrors: 0 });
  expect(report.gate).toEqual({ passed: true, reason: null });
  expect(report.runReports).toHaveLength(3);
  expect(run.stdout).not.toContain("把报销事由改成客户拜访");
});

it("never gives sampled repeats a full gate and rejects repeated repeat options", () => {
  const sampled = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/eval-agent-workflow.ts", "fixture", "1", "--repeat", "3"], {
    cwd: resolve("."), encoding: "utf8", timeout: 30_000,
  });
  expect(sampled.status, sampled.stderr).toBe(0);
  expect(JSON.parse(sampled.stdout)).toMatchObject({ totalCases: 1, gate: null, stability: { runs: 3, sampled: true, passed: false } });
  const duplicate = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/eval-agent-workflow.ts", "fixture", "--repeat", "1", "--repeat", "3"], {
    cwd: resolve("."), encoding: "utf8", timeout: 30_000,
  });
  expect(duplicate.status).toBe(1);
  expect(duplicate.stdout).toBe("");
});
