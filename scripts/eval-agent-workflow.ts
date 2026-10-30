import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import { evaluateAgentWorkflows, parseAgentWorkflowDataset, summarizeWorkflowRuns } from "@/src/application/evaluate-agent-workflow";
import { replayAgentWorkflow } from "@/src/application/replay-agent-workflow";
import { OpenAiCompatibleChatModel } from "@/src/infrastructure/model/openai-compatible-chat-model";

async function main() {
  const mode = process.argv[2] ?? "fixture";
  if (mode !== "fixture" && mode !== "real") throw new Error("mode must be fixture or real");
  const argumentsAfterMode = process.argv.slice(3);
  let selector: string | undefined;
  let repeat = 1;
  let repeatProvided = false;
  for (let index = 0; index < argumentsAfterMode.length; index++) {
    const argument = argumentsAfterMode[index];
    if (argument === "--repeat") {
      const value = argumentsAfterMode[++index];
      if (!value || !/^[1-9]\d*$/.test(value) || repeatProvided) throw new Error("--repeat requires one positive integer");
      repeat = Number(value);
      repeatProvided = true;
    } else if (!selector && !argument.startsWith("--")) selector = argument;
    else throw new Error("unexpected workflow evaluation argument");
  }
  if (!Number.isSafeInteger(repeat) || repeat > 10) throw new Error("--repeat must be between 1 and 10");
  const maxCases = selector && /^\d+$/.test(selector) ? Number(selector) : undefined;
  const caseId = selector && maxCases === undefined ? selector : undefined;
  if (maxCases !== undefined && (!Number.isSafeInteger(maxCases) || maxCases < 1)) throw new Error("maxCases must be a positive integer");
  const cases = parseAgentWorkflowDataset(await readFile(resolve("tests/fixtures/agent-workflow/workflow-v2.jsonl"), "utf8"));
  const selected = caseId ? cases.filter((item) => item.id === caseId) : maxCases === undefined ? cases : cases.slice(0, maxCases);
  if (!selected.length) throw new Error("unknown workflow case id");
  let model: OpenAiCompatibleChatModel | undefined;
  if (mode === "real") {
    loadEnv({ path: resolve(".env.local"), quiet: true });
    if (process.env.MODEL_PROVIDER !== "openai-compatible" || !process.env.MODEL_BASE_URL || !process.env.MODEL_NAME || !process.env.MODEL_PROVIDER_API_KEY) throw new Error("real mode requires configured OpenAI-compatible model");
    model = new OpenAiCompatibleChatModel({ baseUrl: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME, apiKey: process.env.MODEL_PROVIDER_API_KEY, timeoutMs: Number(process.env.MODEL_TIMEOUT_MS) || 20_000 });
  }
  const sampled = selected.length !== cases.length;
  const reports = [];
  for (let index = 0; index < repeat; index++) reports.push(await evaluateAgentWorkflows(selected, (item) => replayAgentWorkflow(item, model), sampled));
  const stability = summarizeWorkflowRuns(reports, sampled);
  const gate = sampled ? null : { passed: stability.passed, reason: stability.modelErrors > 0 ? "model_unavailable_or_failed" : stability.passed ? null : "workflow_assertion_failed" };
  process.stdout.write(`${JSON.stringify({
    dataset: "workflow-v2", mode, model: model ? process.env.MODEL_NAME : "fixture", gate,
    totalCases: selected.length, totalTurns: reports[0].totalTurns,
    stability,
    runReports: reports.map((report, index) => ({
      index: index + 1, passed: report.passed, passedCases: report.passedCases, passedTurns: report.passedTurns,
      safetyErrors: report.safetyErrors, modelErrors: report.modelErrors,
      failures: report.results.filter((item) => !item.passed),
    })),
  })}\n`);
  if (gate && !gate.passed) process.exitCode = 1;
}

main().catch(() => { process.stderr.write("agent workflow evaluation failed; check mode, dataset and model configuration\n"); process.exitCode = 1; });
