import { expect, it, vi } from "vitest";
import { searchPolicyKnowledge } from "@/src/application/search-policy-knowledge";

const embed = { embed: async () => [Array(1024).fill(0)] };
const hit = (id: string, sectionId: string | null, content: string, score = 0.9) => ({ id, sectionId, content, headingPath: ["住宿费"], sourceAnchor: "#lodging", canonicalUrl: "https://x", title: "差旅", score });

it("expands matching chunks once to the complete lodging section and keeps citations short", async () => {
  const full = `北京、上海 600 元/晚\n广州、深圳、杭州 500 元/晚\n其他城市 400 元/晚\n${"报销说明。".repeat(110)}`;
  const loadSections = vi.fn(async () => [{ id: "s1", title: "差旅", headingPath: ["住宿费"], content: full, sourceAnchor: "#lodging", canonicalUrl: "https://x", complete: true }]);
  const result = await searchPolicyKnowledge({ query: "住宿规则", limit: 3 }, { embeddings: embed, chunks: { searchChunks: async ({ limit }) => { expect(limit).toBe(12); return [hit("c1", "s1", "北京、上海 600 元/晚"), hit("c2", "s1", "其他城市 400 元/晚"), hit("c3", "s2", "交通费", 0.1)]; }, loadSections } });
  expect(loadSections).toHaveBeenCalledWith(["s1"]);
  expect(result.evidence).toEqual([{ sectionId: "s1", title: "差旅", headingPath: ["住宿费"], text: full, complete: true }]);
  expect(result.citations).toHaveLength(1);
  expect(result.citations[0].excerpt).toBe("北京、上海 600 元/晚");
  expect(result.citations[0].excerpt.length).toBeLessThan(200);
  expect(result.incomplete).toBe(false);
});

it("marks oversized evidence incomplete rather than silently cutting after 500 characters", async () => {
  const result = await searchPolicyKnowledge({ query: "住宿", limit: 3 }, { embeddings: embed, chunks: { searchChunks: async () => [hit("c1", "s1", "住宿")], loadSections: async () => [{ id: "s1", title: "差旅", headingPath: ["住宿费"], content: "甲".repeat(8001), sourceAnchor: null, canonicalUrl: "https://x", complete: false }] } });
  expect(result).toMatchObject({ evidence: [], incomplete: true, citations: [expect.objectContaining({ excerpt: "住宿" })] });
});

it("treats legacy chunk-only indexes as incomplete evidence", async () => {
  const result = await searchPolicyKnowledge({ query: "住宿", limit: 3 }, { embeddings: embed, chunks: { searchChunks: async () => [hit("old", null, "住宿上限 500 元")], loadSections: async () => [] } });
  expect(result).toMatchObject({ evidence: [], incomplete: true });
});

it("uses at most three ranked sections and never truncates a section to fit the shared budget", async () => {
  const hits = ["s1", "s2", "s3", "s4"].map((id) => hit(`c-${id}`, id, `命中 ${id}`));
  const result = await searchPolicyKnowledge({ query: "报销规则", limit: 5 }, { embeddings: embed, chunks: {
    searchChunks: async () => hits,
    loadSections: async (ids) => ids.map((id) => ({ id, title: "制度", headingPath: [id], content: id === "s1" ? "甲".repeat(5000) : "乙".repeat(4000), sourceAnchor: null, canonicalUrl: "https://x", complete: true })),
  } });
  expect(result.citations).toHaveLength(3);
  expect(result.evidence.map((item) => item.sectionId)).toEqual(["s1"]);
  expect(result.incomplete).toBe(true);
});

it("returns no fabricated evidence or citations when similarity is below threshold", async () => {
  const result = await searchPolicyKnowledge({ query: "不相关", limit: 3 }, { embeddings: embed, chunks: { searchChunks: async () => [hit("c1", "s1", "住宿", 0.1)], loadSections: async () => { throw new Error("must not load"); } } });
  expect(result).toEqual({ evidence: [], citations: [], incomplete: false });
});
