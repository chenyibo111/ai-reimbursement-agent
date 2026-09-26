import { EMBEDDING_DIMENSIONS, type EmbeddingProvider, validateEmbeddingTexts } from "@/src/infrastructure/embedding/embedding-provider";

export class FixtureEmbeddingProvider implements EmbeddingProvider {
  async embed(input: { texts: string[] }): Promise<number[][]> {
    validateEmbeddingTexts(input.texts);
    return input.texts.map((text) => deterministicVector(text));
  }
}

function deterministicVector(text: string) {
  let state = 2166136261;
  for (const codePoint of text.trim()) {
    state ^= codePoint.codePointAt(0) ?? 0;
    state = Math.imul(state, 16777619);
  }
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1 + index * 0;
  });
}
