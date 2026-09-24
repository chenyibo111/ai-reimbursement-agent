export type AppConfig = {
  isProduction: boolean;
  receiptExtractionProvider?: string;
  modelProvider?: "fixture" | "openai-compatible";
  model?: {
    baseUrl: string;
    name: string;
    apiKey: string;
    timeoutMs: number;
  };
  sessionSecret?: string;
  feishuOAuth?: {
    appId: string;
    appSecret: string;
    redirectUri: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const isProduction = env.NODE_ENV === "production";

  if (isProduction && !env.RECEIPT_EXTRACTION_PROVIDER) {
    throw new Error("RECEIPT_EXTRACTION_PROVIDER is required in production");
  }

  if (isProduction && env.RECEIPT_EXTRACTION_PROVIDER === "fixture") {
    throw new Error("fixture provider is not allowed in production");
  }

  const configuredModelProvider = env.MODEL_PROVIDER;
  if (isProduction && !configuredModelProvider) {
    throw new Error("MODEL_PROVIDER is required in production");
  }

  if (configuredModelProvider && configuredModelProvider !== "fixture" && configuredModelProvider !== "openai-compatible") {
    throw new Error("MODEL_PROVIDER must be fixture or openai-compatible");
  }
  const modelProvider: AppConfig["modelProvider"] = configuredModelProvider as AppConfig["modelProvider"];

  if (isProduction && !env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required in production");
  }

  if (isProduction && !env.FEISHU_APP_ID) {
    throw new Error("FEISHU_APP_ID is required in production");
  }

  if (isProduction && !env.FEISHU_APP_SECRET) {
    throw new Error("FEISHU_APP_SECRET is required in production");
  }

  if (isProduction && !env.FEISHU_REDIRECT_URI) {
    throw new Error("FEISHU_REDIRECT_URI is required in production");
  }

  if (isProduction && modelProvider === "fixture") {
    throw new Error("fixture model provider is not allowed in production");
  }

  const model = modelProvider === "openai-compatible"
    ? parseOpenAiCompatibleModelConfig(env)
    : undefined;

  const hasCompleteFeishuConfig = Boolean(
    env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_REDIRECT_URI,
  );

  return {
    isProduction,
    receiptExtractionProvider: env.RECEIPT_EXTRACTION_PROVIDER,
    modelProvider,
    model,
    sessionSecret: env.SESSION_SECRET,
    feishuOAuth: hasCompleteFeishuConfig
      ? {
          appId: env.FEISHU_APP_ID!,
          appSecret: env.FEISHU_APP_SECRET!,
          redirectUri: env.FEISHU_REDIRECT_URI!,
        }
      : undefined,
  };
}

function parseOpenAiCompatibleModelConfig(env: NodeJS.ProcessEnv) {
  const baseUrl = required(env.MODEL_BASE_URL, "MODEL_BASE_URL is required for openai-compatible");
  const name = required(env.MODEL_NAME, "MODEL_NAME is required for openai-compatible");
  const apiKey = required(env.MODEL_PROVIDER_API_KEY, "MODEL_PROVIDER_API_KEY is required for openai-compatible");
  const timeoutMs = env.MODEL_TIMEOUT_MS ? Number(env.MODEL_TIMEOUT_MS) : 20_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("MODEL_TIMEOUT_MS must be an integer between 1000 and 120000");
  }
  return { baseUrl, name, apiKey, timeoutMs };
}

function required(value: string | undefined, message: string) {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}
