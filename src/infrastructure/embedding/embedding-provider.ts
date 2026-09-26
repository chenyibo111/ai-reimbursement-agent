export const EMBEDDING_DIMENSIONS = 1024;
export const MAX_EMBEDDING_BATCH_SIZE = 32;
export const MAX_EMBEDDING_TEXT_LENGTH = 12_000;

export type EmbeddingProvider = {
  embed(input: { texts: string[] }): Promise<number[][]>;
};

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE",
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export function validateEmbeddingTexts(texts: string[]) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBEDDING_BATCH_SIZE) {
    throw new EmbeddingProviderError("Embedding 输入数量无效。", "INVALID_INPUT");
  }
  if (texts.some((text) => typeof text !== "string" || !text.trim() || text.length > MAX_EMBEDDING_TEXT_LENGTH)) {
    throw new EmbeddingProviderError("Embedding 文本无效。", "INVALID_INPUT");
  }
}

export function validateEmbeddingVectors(vectors: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new EmbeddingProviderError("Embedding 服务返回内容无法识别。", "INVALID_RESPONSE");
  }
  return vectors.map((vector) => {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new EmbeddingProviderError("Embedding 服务返回内容无法识别。", "INVALID_RESPONSE");
    }
    return vector;
  });
}
