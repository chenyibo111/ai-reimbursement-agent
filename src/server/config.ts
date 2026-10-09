export type AppConfig = {
  isProduction: boolean;
  policyAdminOpenIds: ReadonlySet<string>;
  embedding?: EmbeddingConfig;
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
  feishuBot?: FeishuBotConfig;
};

export type EmbeddingConfig = {
  provider: "fixture" | "bge-m3" | "openai-compatible";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  dimensions: 1024;
  timeoutMs?: number;
};

export type FeishuBotConfig = {
  appId: string;
  appSecret: string;
  botOpenId: string;
  publicAppUrl: string;
  eventDelivery: "long_connection";
};

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
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
  const embedding = parseEmbeddingConfig(env, isProduction);

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
  const feishuBot = parseFeishuBotConfig(env);

  return {
    isProduction,
    policyAdminOpenIds: parsePolicyAdminOpenIds(env.POLICY_ADMIN_FEISHU_OPEN_IDS),
    embedding,
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
    feishuBot,
  };
}

function parseEmbeddingConfig(env: Record<string, string | undefined>, isProduction: boolean): EmbeddingConfig | undefined {
  const provider = env.EMBEDDING_PROVIDER;
  if (!provider) return undefined;
  if (provider !== "fixture" && provider !== "bge-m3" && provider !== "openai-compatible") {
    throw new Error("EMBEDDING_PROVIDER must be fixture, bge-m3 or openai-compatible");
  }

  const dimensions = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : 1024;
  if (dimensions !== 1024) throw new Error("EMBEDDING_DIMENSIONS must be 1024");
  if (provider === "fixture") {
    if (isProduction) throw new Error("fixture embedding provider is not allowed in production");
    return { provider, dimensions };
  }

  const baseUrl = required(env.EMBEDDING_BASE_URL, `EMBEDDING_BASE_URL is required for ${provider} embedding`);
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("EMBEDDING_BASE_URL must be a valid URL");
  }
  const timeoutMs = env.EMBEDDING_TIMEOUT_MS ? Number(env.EMBEDDING_TIMEOUT_MS) : 20_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("EMBEDDING_TIMEOUT_MS must be an integer between 1000 and 120000");
  }
  return {
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: env.EMBEDDING_MODEL?.trim() || "BAAI/bge-m3",
    apiKey: env.EMBEDDING_PROVIDER_API_KEY?.trim() || undefined,
    dimensions,
    timeoutMs,
  };
}

function parsePolicyAdminOpenIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((openId) => openId.trim())
      .filter((openId) => /^ou_[A-Za-z0-9_]+$/.test(openId)),
  );
}

export function validateFeishuWorkerEnvironment(env: Record<string, string | undefined>): FeishuBotConfig {
  const bot = loadConfig(env).feishuBot;
  if (!bot) throw new Error("FEISHU_BOT_ENABLED=true is required to start the Feishu worker");
  const publicAppUrl = new URL(bot.publicAppUrl);
  if (env.NODE_ENV === "production" && publicAppUrl.protocol !== "https:" && !isLoopbackHttpUrl(publicAppUrl)) {
    throw new Error("APP_PUBLIC_URL must use HTTPS in production");
  }
  for (const name of ["DATABASE_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "CLAMAV_HOST", "OCR_SERVICE_URL"]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required to start the Feishu worker`);
  }
  return bot;
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
}

function parseFeishuBotConfig(env: Record<string, string | undefined>): FeishuBotConfig | undefined {
  if (env.FEISHU_BOT_ENABLED !== "true") return undefined;

  const botOpenId = required(env.FEISHU_BOT_OPEN_ID, "FEISHU_BOT_OPEN_ID is required when FEISHU_BOT_ENABLED=true");
  const publicAppUrl = required(env.APP_PUBLIC_URL, "APP_PUBLIC_URL is required when FEISHU_BOT_ENABLED=true");
  try {
    new URL(publicAppUrl);
  } catch {
    throw new Error("APP_PUBLIC_URL must be a valid URL");
  }
  const eventDelivery = env.FEISHU_EVENT_DELIVERY ?? "long_connection";
  if (eventDelivery !== "long_connection") throw new Error("FEISHU_EVENT_DELIVERY must be long_connection");

  return {
    appId: required(env.FEISHU_APP_ID, "FEISHU_APP_ID is required when FEISHU_BOT_ENABLED=true"),
    appSecret: required(env.FEISHU_APP_SECRET, "FEISHU_APP_SECRET is required when FEISHU_BOT_ENABLED=true"),
    botOpenId,
    publicAppUrl: publicAppUrl.replace(/\/$/, ""),
    eventDelivery,
  };
}

function parseOpenAiCompatibleModelConfig(env: Record<string, string | undefined>) {
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
