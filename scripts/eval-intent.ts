import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateIntent, parseIntentEvalDataset, type IntentEvalReport } from "@/src/application/evaluate-intent";
import type { ConversationContext } from "@/src/application/build-conversation-context";
import type { ConversationDecision } from "@/src/infrastructure/model/chat-model";
import { OpenAiCompatibleChatModel } from "@/src/infrastructure/model/openai-compatible-chat-model";

export const INTENT_PROMPT_VERSION = "semantic-intent-v1";

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
  input.write(JSON.stringify({ model: input.modelName, promptVersion: INTENT_PROMPT_VERSION, datasetVersion: input.datasetVersion, sampled: selected.length !== cases.length, ...report }));
  return report;
}

async function main() {
  const datasetVersion = process.argv[2] ?? "holdout";
  if (datasetVersion !== "dev" && datasetVersion !== "holdout") throw new Error("dataset must be dev or holdout");
  const maxCases = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  const config = resolveIntentEvalModelConfig(process.env);
  const model = new OpenAiCompatibleChatModel({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  const datasetText = await readFile(resolve("tests", "fixtures", "intent-eval", `${datasetVersion}.jsonl`), "utf8");
  await runIntentEvalCli({ datasetText, datasetVersion, modelName: config.model, maxCases, decide: (context) => model.decideConversation(context), write: (line) => process.stdout.write(`${line}\n`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "intent evaluation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
