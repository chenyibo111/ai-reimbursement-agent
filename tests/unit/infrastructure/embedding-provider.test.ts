import { describe, expect, it, vi } from "vitest";

import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { HttpEmbeddingProvider } from "@/src/infrastructure/embedding/http-embedding-provider";

describe("Embedding providers", () => {
  it("uses deterministic 1024-dimension fixture vectors for local development", async () => {
    const provider = createEmbeddingProvider({
      isProduction: false,
      policyAdminOpenIds: new Set(),
      embedding: { provider: "fixture", dimensions: 1024 },
    });

    const first = await provider.embed({ texts: ["差旅住宿标准", "差旅住宿标准"] });
    const second = await provider.embed({ texts: ["差旅住宿标准"] });

    expect(first).toHaveLength(2);
    expect(first[0]).toHaveLength(1024);
    expect(first[0]).toEqual(first[1]);
    expect(first[0]).toEqual(second[0]);
    expect(first[0]?.every(Number.isFinite)).toBe(true);
  });

  it("rejects empty text before sending an embedding request", async () => {
    const provider = createEmbeddingProvider({
      isProduction: false,
      policyAdminOpenIds: new Set(),
      embedding: { provider: "fixture", dimensions: 1024 },
    });

    await expect(provider.embed({ texts: ["  "] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("posts a bounded batch to the private embedding endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      vectors: [Array.from({ length: 1024 }, () => 0.25)],
    }), { status: 200 }));
    const provider = new HttpEmbeddingProvider({
      baseUrl: "http://embedding:8080/",
      model: "BAAI/bge-m3",
      fetchImpl,
    });

    await expect(provider.embed({ texts: ["差旅住宿标准"] })).resolves.toEqual([
      Array.from({ length: 1024 }, () => 0.25),
    ]);
    const [url, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://embedding:8080/embed");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(request.body))).toEqual({ texts: ["差旅住宿标准"], model: "BAAI/bge-m3" });
  });

  it.each([
    ["non-success response", vi.fn().mockResolvedValue(new Response("internal detail", { status: 503 })), "UNAVAILABLE"],
    ["invalid vector", vi.fn().mockResolvedValue(new Response(JSON.stringify({ vectors: [[Number.NaN]] }), { status: 200 })), "INVALID_RESPONSE"],
    ["timeout", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")), "TIMEOUT"],
  ])("maps %s to a safe typed error", async (_case, fetchImpl, code) => {
    const provider = new HttpEmbeddingProvider({ baseUrl: "http://embedding:8080", model: "BAAI/bge-m3", fetchImpl });

    await expect(provider.embed({ texts: ["差旅住宿标准"] })).rejects.toMatchObject({ code });
  });
});
