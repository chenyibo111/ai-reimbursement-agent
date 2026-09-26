import type { AppConfig } from "@/src/server/config";
import { FixtureEmbeddingProvider } from "@/src/infrastructure/embedding/fixture-embedding-provider";
import { HttpEmbeddingProvider } from "@/src/infrastructure/embedding/http-embedding-provider";
import type { EmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider";

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  const embedding = config.embedding;
  if (!embedding) throw new Error("embedding provider is not configured");
  if (embedding.provider === "fixture") return new FixtureEmbeddingProvider();
  return new HttpEmbeddingProvider({
    baseUrl: embedding.baseUrl!,
    model: embedding.model!,
    apiKey: embedding.apiKey,
    timeoutMs: embedding.timeoutMs,
    protocol: embedding.provider,
  });
}
