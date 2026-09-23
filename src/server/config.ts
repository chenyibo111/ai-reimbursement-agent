export type AppConfig = {
  isProduction: boolean;
  receiptExtractionProvider?: string;
  modelProvider?: string;
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

  if (isProduction && !env.MODEL_PROVIDER) {
    throw new Error("MODEL_PROVIDER is required in production");
  }

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

  const hasCompleteFeishuConfig = Boolean(
    env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_REDIRECT_URI,
  );

  return {
    isProduction,
    receiptExtractionProvider: env.RECEIPT_EXTRACTION_PROVIDER,
    modelProvider: env.MODEL_PROVIDER,
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
