import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateIntent, intentActions, parseIntentEvalDataset, type IntentEvalReport } from "@/src/application/evaluate-intent";
import type { ConversationContext } from "@/src/application/build-conversation-context";
import type { ConversationDecision } from "@/src/infrastructure/model/chat-model";
import { OpenAiCompatibleChatModel } from "@/src/infrastructure/model/openai-compatible-chat-model";

export const INTENT_PROMPT_VERSION = "semantic-intent-v3";

export function checkIntentEvalGate(report: IntentEvalReport): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (intentActions.some((action) => report.byAction[action].support < 2)) reasons.push("missing_action_coverage");
  if (report.macroF1 < 0.9) reasons.push("macro_f1_below_0.9");
  if (report.outOfScopeRecall < 0.9) reasons.push("out_of_scope_recall_below_0.9");
  if (report.decisionAccuracy < 0.9) reasons.push("decision_accuracy_below_0.9");
  if (report.dangerousPrepareFalsePositives > 0) reasons.push("unsafe_submit_preparation");
  if (report.dangerousWriteTargetErrors > 0) reasons.push("dangerous_write_target_errors");
  if (report.targetReferenceErrors > 0) reasons.push("target_reference_errors");
  if (report.failureCount > 0) reasons.push("model_failures");
  return { passed: reasons.length === 0, reasons };
}

export function shouldFailIntentEvalRun(datasetVersion: string, report: IntentEvalReport, datasetSize: number): boolean {
  return datasetVersion === "holdout-v3" && report.total === datasetSize && !checkIntentEvalGate(report).passed;
}

export function resolveIntentEvalModelConfig(env: Record<string, string | undefined>) {
  if (env.MODEL_PROVIDER !== "openai-compatible") throw new Error("intent evaluation requires MODEL_PROVIDER=openai-compatible");
  if (!env.MODEL_BASE_URL) throw new Error("MODEL_BASE_URL is required");
  if (!env.MODEL_NAME) throw new Error("MODEL_NAME is required");
  if (!env.MODEL_PROVIDER_API_KEY) throw new Error("MODEL_PROVIDER_API_KEY is required");
  return { baseUrl: env.MODEL_BASE_URL, model: env.MODEL_NAME, apiKey: env.MODEL_PROVIDER_API_KEY, timeoutMs: Number(env.MODEL_TIMEOUT_MS) || 20_000 };
}

export async function runIntentEvalCli(input: {
  datasetText: string;
  datasetVersion: string;
  modelName: string;
  maxCases?: number;
  decide: (context: ConversationContext) => Promise<ConversationDecision>;
  write: (line: string) => void;
}): Promise<IntentEvalReport> {
  const cases = parseIntentEvalDataset(input.datasetText);
  if (input.maxCases !== undefined && (!Number.isSafeInteger(input.maxCases) || input.maxCases < 1)) throw new Error("maxCases must be a positive integer");
  const selected = input.maxCases === undefined ? cases : cases.slice(0, input.maxCases);
  const report = await evaluateIntent(selected, input.decide);
  const fullCurrentHoldout = input.datasetVersion === "holdout-v3" && selected.length === cases.length;
  input.write(JSON.stringify({ model: input.modelName, promptVersion: INTENT_PROMPT_VERSION, datasetVersion: input.datasetVersion, sampled: selected.length !== cases.length, gate: fullCurrentHoldout ? checkIntentEvalGate(report) : null, ...report }));
  return report;
}

async function main() {
  const datasetVersion = process.argv[2] ?? "holdout-v3";
  if (!["dev", "holdout", "dev-v3", "holdout-v3"].includes(datasetVersion)) throw new Error("dataset must be dev, holdout, dev-v3 or holdout-v3");
  const maxCases = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  const config = resolveIntentEvalModelConfig(process.env);
  const model = new OpenAiCompatibleChatModel({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  const datasetText = await readFile(resolve("tests", "fixtures", "intent-eval", `${datasetVersion}.jsonl`), "utf8");
  const report = await runIntentEvalCli({ datasetText, datasetVersion, modelName: config.model, maxCases, decide: (context) => model.decideConversation(context), write: (line) => process.stdout.write(`${line}\n`) });
  if (shouldFailIntentEvalRun(datasetVersion, report, parseIntentEvalDataset(datasetText).length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "intent evaluation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
