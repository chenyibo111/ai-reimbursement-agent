import type { EmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider";

export type PolicyCitation = { id: string; title: string; url: string; excerpt: string; headingPath: string[]; score: number };
export type PolicyEvidence = { sectionId: string; title: string; headingPath: string[]; text: string; complete: boolean };
export type PolicySearchResult = { evidence: PolicyEvidence[]; citations: PolicyCitation[]; incomplete: boolean };

type ChunkHit = { id: string; sectionId: string | null; content: string; headingPath: string[]; sourceAnchor: string | null; canonicalUrl: string; title: string; score: number };
type LoadedSection = { id: string; title: string; headingPath: string[]; content: string; sourceAnchor: string | null; canonicalUrl: string; complete: boolean };

export async function searchPolicyKnowledge(
  input: { query: string; limit: number },
  deps: { embeddings: EmbeddingProvider; chunks: { searchChunks(input: { vector: number[]; limit: number }): Promise<ChunkHit[]>; loadSections(sectionIds: string[]): Promise<LoadedSection[]> } },
): Promise<PolicySearchResult> {
  const empty = (): PolicySearchResult => ({ evidence: [], citations: [], incomplete: false });
  if (!input.query.trim()) return empty();
  const [vector] = await deps.embeddings.embed({ texts: [input.query.trim()] });
  if (!vector) throw new Error("embedding provider returned no vector");
  const hits = (await deps.chunks.searchChunks({ vector, limit: 12 })).filter((hit) => hit.score >= 0.65);
  const selected: ChunkHit[] = [];
  const keys = new Set<string>();
  for (const hit of hits) {
    const key = hit.sectionId ?? `legacy:${hit.id}`;
    if (keys.has(key)) continue;
    keys.add(key);
    selected.push(hit);
    if (selected.length >= Math.min(3, Math.max(1, Math.floor(input.limit)))) break;
  }
  if (!selected.length) return empty();
  const sections = await deps.chunks.loadSections(selected.flatMap((hit) => hit.sectionId ? [hit.sectionId] : []));
  const byId = new Map(sections.map((section) => [section.id, section]));
  const evidence: PolicyEvidence[] = [];
  const citations: PolicyCitation[] = [];
  let remaining = 8_000;
  let incomplete = false;
  for (const hit of selected) {
    const section = hit.sectionId ? byId.get(hit.sectionId) : undefined;
    const citation = { id: hit.id, title: hit.title, url: `${hit.canonicalUrl}${section?.sourceAnchor ?? hit.sourceAnchor ?? ""}`, excerpt: hit.content.slice(0, 180), headingPath: section?.headingPath ?? hit.headingPath, score: hit.score };
    citations.push(citation);
    if (!section || !section.complete || section.content.length > remaining) { incomplete = true; continue; }
    evidence.push({ sectionId: section.id, title: section.title, headingPath: section.headingPath, text: section.content, complete: true });
    remaining -= section.content.length;
  }
  return { evidence, citations, incomplete };
}
