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

it("quotes the most relevant exact rule line instead of a fixed chunk prefix", async () => {
  const result = await searchPolicyKnowledge({ query: "其他城市住宿上限", limit: 3 }, { embeddings: embed, chunks: {
    searchChunks: async () => [hit("c1", "s1", "北京上海每晚 600 元\n广州深圳每晚 500 元\n其他城市每晚 400 元")],
    loadSections: async () => [{ id: "s1", title: "差旅", headingPath: ["住宿费"], content: "北京上海每晚 600 元\n广州深圳每晚 500 元\n其他城市每晚 400 元", sourceAnchor: null, canonicalUrl: "https://x", complete: true }],
  } });
  expect(result.citations[0].excerpt).toBe("其他城市每晚 400 元");
});

it("expands city-tier siblings when lodging is the parent chapter", async () => {
  const family = [
    { id: "city-a", title: "差旅", headingPath: ["住宿费", "北京上海"], content: "每晚 600 元", sourceAnchor: "#a", canonicalUrl: "https://x", complete: true },
    { id: "city-b", title: "差旅", headingPath: ["住宿费", "重点城市"], content: "每晚 500 元", sourceAnchor: "#b", canonicalUrl: "https://x", complete: true },
    { id: "city-c", title: "差旅", headingPath: ["住宿费", "其他城市"], content: "每晚 400 元", sourceAnchor: "#c", canonicalUrl: "https://x", complete: true },
    { id: "exception", title: "差旅", headingPath: ["住宿费", "例外"], content: "统一安排住宿不报销", sourceAnchor: "#d", canonicalUrl: "https://x", complete: true },
  ];
  const loadSectionFamily = vi.fn(async (_id: string, prefix: string[]) => { expect(prefix).toEqual(["住宿费"]); return family; });
  const result = await searchPolicyKnowledge({ query: "住宿费规则", limit: 3 }, { embeddings: embed, chunks: { searchChunks: async () => [hit("c1", "city-a", "每晚 600 元")], loadSections: async () => [family[0]!], loadSectionFamily } });
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0].text).toContain("600 元");
  expect(result.evidence[0].text).toContain("500 元");
  expect(result.evidence[0].text).toContain("400 元");
  expect(result.evidence[0].text).toContain("统一安排住宿不报销");
  expect(result.incomplete).toBe(false);
});

it("keeps transport outside a lodging topic nested under a travel chapter", async () => {
  const selected = { id: "lodging", title: "差旅", headingPath: ["差旅费", "住宿费"], content: "住宿每晚 600 元", sourceAnchor: null, canonicalUrl: "https://x", complete: true };
  const loadSectionFamily = vi.fn(async (_id: string, prefix: string[]) => { expect(prefix).toEqual(["差旅费", "住宿费"]); return [selected]; });
  const result = await searchPolicyKnowledge({ query: "住宿费规则", limit: 3 }, { embeddings: embed, chunks: { searchChunks: async () => [hit("c1", "lodging", "住宿每晚 600 元")], loadSections: async () => [selected], loadSectionFamily } });
  expect(result.evidence[0].text).toBe("住宿每晚 600 元");
  expect(result.incomplete).toBe(false);
});

it("expands h3 city tiers below an h2 lodging topic without including h2 transport", async () => {
  const family = [
    { id: "a", title: "差旅", headingPath: ["差旅费", "住宿费", "北京上海"], content: "每晚 600 元", sourceAnchor: null, canonicalUrl: "https://x", complete: true },
    { id: "b", title: "差旅", headingPath: ["差旅费", "住宿费", "重点城市"], content: "每晚 500 元", sourceAnchor: null, canonicalUrl: "https://x", complete: true },
    { id: "c", title: "差旅", headingPath: ["差旅费", "住宿费", "其他城市"], content: "每晚 400 元", sourceAnchor: null, canonicalUrl: "https://x", complete: true },
  ];
  const result = await searchPolicyKnowledge({ query: "住宿费规则", limit: 3 }, { embeddings: embed, chunks: {
    searchChunks: async () => [hit("c1", "a", "每晚 600 元")],
    loadSections: async () => [family[0]!],
    loadSectionFamily: async (_id, prefix) => { expect(prefix).toEqual(["差旅费", "住宿费"]); return family; },
  } });
  expect(result.evidence[0].text).toContain("600 元");
  expect(result.evidence[0].text).toContain("500 元");
  expect(result.evidence[0].text).toContain("400 元");
  expect(result.evidence[0].text).not.toContain("交通");
});

it("prefers the lodging topic over a matching generic ancestor", async () => {
  const selected = { id: "a", title: "制度", headingPath: ["报销政策", "住宿费", "北京上海"], content: "每晚 600 元", sourceAnchor: null, canonicalUrl: "https://x", complete: true };
  const sibling = { ...selected, id: "b", headingPath: ["报销政策", "住宿费", "其他城市"], content: "每晚 400 元" };
  const result = await searchPolicyKnowledge({ query: "住宿费报销规则", limit: 3 }, { embeddings: embed, chunks: {
    searchChunks: async () => [hit("c1", "a", "每晚 600 元")],
    loadSections: async () => [selected],
    loadSectionFamily: async (_id, prefix) => { expect(prefix).toEqual(["报销政策", "住宿费"]); return [selected, sibling]; },
  } });
  expect(result.evidence[0].text).toContain("400 元");
  expect(result.incomplete).toBe(false);
});

it("expands a root lodging hit to its subordinate city tiers", async () => {
  const root = { id: "lodging", title: "制度", headingPath: ["住宿费"], content: "住宿应按标准报销", sourceAnchor: null, canonicalUrl: "https://x", complete: true };
  const tier = { ...root, id: "tier", headingPath: ["住宿费", "北京上海"], content: "每晚 600 元" };
  const result = await searchPolicyKnowledge({ query: "住宿费规则", limit: 3 }, { embeddings: embed, chunks: {
    searchChunks: async () => [hit("c1", "lodging", "住宿应按标准报销")],
    loadSections: async () => [root],
    loadSectionFamily: async (_id, prefix) => { expect(prefix).toEqual(["住宿费"]); return [root, tier]; },
  } });
  expect(result.evidence[0].text).toContain("每晚 600 元");
});
