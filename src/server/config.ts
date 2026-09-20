export type AppConfig = {
  isProduction: boolean;
  receiptExtractionProvider?: string;
  modelProvider?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const isProduction = env.NODE_ENV === "production";

  if (isProduction && !env.RECEIPT_EXTRACTION_PROVIDER) {
    throw new Error("RECEIPT_EXTRACTION_PROVIDER is required in production");
  }

  if (isProduction && !env.MODEL_PROVIDER) {
    throw new Error("MODEL_PROVIDER is required in production");
  }

  return {
    isProduction,
    receiptExtractionProvider: env.RECEIPT_EXTRACTION_PROVIDER,
    modelProvider: env.MODEL_PROVIDER,
  };
}
