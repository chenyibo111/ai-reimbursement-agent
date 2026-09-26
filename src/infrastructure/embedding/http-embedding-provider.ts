import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  validateEmbeddingTexts,
  validateEmbeddingVectors,
} from "@/src/infrastructure/embedding/embedding-provider";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type HttpEmbeddingProviderOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  protocol?: "bge-m3" | "openai-compatible";
  fetchImpl?: Fetch;
};

export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly endpoint: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;
  private readonly protocol: "bge-m3" | "openai-compatible";

  constructor(private readonly options: HttpEmbeddingProviderOptions) {
    this.protocol = options.protocol ?? "bge-m3";
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}${this.protocol === "bge-m3" ? "/embed" : "/embeddings"}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async embed(input: { texts: string[] }): Promise<number[][]> {
    validateEmbeddingTexts(input.texts);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(this.protocol === "bge-m3"
          ? { texts: input.texts, model: this.options.model }
          : { input: input.texts, model: this.options.model }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new EmbeddingProviderError("Embedding 服务响应超时，请稍后重试。", "TIMEOUT");
      }
      throw new EmbeddingProviderError("Embedding 服务暂不可用，请稍后重试。", "UNAVAILABLE");
    }

    if (!response.ok) throw new EmbeddingProviderError("Embedding 服务暂不可用，请稍后重试。", "UNAVAILABLE");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmbeddingProviderError("Embedding 服务返回内容无法识别。", "INVALID_RESPONSE");
    }
    const vectors = this.protocol === "bge-m3" ? readBgeVectors(payload) : readOpenAiVectors(payload);
    return validateEmbeddingVectors(vectors, input.texts.length);
  }
}

function readBgeVectors(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return (payload as { vectors?: unknown }).vectors;
}

function readOpenAiVectors(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  return data.map((item) => item && typeof item === "object" ? (item as { embedding?: unknown }).embedding : undefined);
}
