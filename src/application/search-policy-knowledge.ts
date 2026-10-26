import type { EmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider";

export type PolicyCitation = { id: string; title: string; url: string; excerpt: string; headingPath: string[]; score: number };
export type PolicyEvidence = { sectionId: string; title: string; headingPath: string[]; text: string; complete: boolean };
export type PolicySearchResult = { evidence: PolicyEvidence[]; citations: PolicyCitation[]; incomplete: boolean };

type ChunkHit = { id: string; sectionId: string | null; content: string; headingPath: string[]; sourceAnchor: string | null; canonicalUrl: string; title: string; score: number };
type LoadedSection = { id: string; title: string; headingPath: string[]; content: string; sourceAnchor: string | null; canonicalUrl: string; complete: boolean };

export async function searchPolicyKnowledge(
  input: { query: string; limit: number },
  deps: { embeddings: EmbeddingProvider; chunks: { searchChunks(input: { vector: number[]; limit: number }): Promise<ChunkHit[]>; loadSections(sectionIds: string[]): Promise<LoadedSection[]>; loadSectionFamily?(sectionId: string, headingPrefix: string[]): Promise<LoadedSection[]> } },
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
  const includedFamilies = new Set<string>();
  let remaining = 8_000;
  let incomplete = false;
  for (const hit of selected) {
    const section = hit.sectionId ? byId.get(hit.sectionId) : undefined;
    const citation = { id: hit.id, title: hit.title, url: `${hit.canonicalUrl}${section?.sourceAnchor ?? hit.sourceAnchor ?? ""}`, excerpt: selectExactRule(hit.content, input.query), headingPath: section?.headingPath ?? hit.headingPath, score: hit.score };
    citations.push(citation);
    if (!section) { incomplete = true; continue; }
    const matchingLevel = section.headingPath.reduce((level, heading, index) => headingOverlap(input.query, heading)
      ? Math.max(level, index === section.headingPath.length - 1 && index > 1 ? index - 1 : index)
      : level, -1);
    const prefix = section.headingPath.slice(0, matchingLevel >= 0 ? matchingLevel + 1 : Math.max(1, section.headingPath.length - 1));
    const family = await deps.chunks.loadSectionFamily?.(section.id, prefix) ?? (section.headingPath.length === 1 ? [section] : undefined);
    if (!family?.length || !family.some((member) => member.id === section.id)) { incomplete = true; continue; }
    const familyKey = family.map((member) => member.id).join("|");
    if (includedFamilies.has(familyKey)) continue;
    includedFamilies.add(familyKey);
    const text = family.map((member) => [member.headingPath.slice(prefix.length).join(" / "), member.content].filter(Boolean).join("\n")).join("\n");
    if (family.some((member) => !member.complete) || text.length > remaining) { incomplete = true; continue; }
    evidence.push({ sectionId: section.id, title: section.title, headingPath: prefix, text, complete: true });
    remaining -= text.length;
  }
  return { evidence, citations, incomplete };
}

function headingOverlap(query: string, heading: string): boolean {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, "");
  const normalizedHeading = heading.toLowerCase().replace(/\s+/g, "");
  for (let index = 0; index + 1 < normalizedHeading.length; index += 1) {
    if (normalizedQuery.includes(normalizedHeading.slice(index, index + 2))) return true;
  }
  return normalizedHeading.length === 1 && normalizedQuery.includes(normalizedHeading);
}

function selectExactRule(content: string, query: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  const terms = new Set<string>();
  const normalized = query.toLowerCase().replace(/\s+/g, "");
  for (let index = 0; index + 1 < normalized.length; index += 1) terms.add(normalized.slice(index, index + 2));
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) terms.add(word);
  const ranked = lines.map((line, index) => ({ line, index, score: [...terms].filter((term) => line.toLowerCase().includes(term)).length }));
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0]!.line;
  if (selected.length <= 180) return selected;
  const match = [...terms].map((term) => selected.toLowerCase().indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.min(Math.max(0, match - 40), selected.length - 180);
  return `${start ? "…" : ""}${selected.slice(start, start + 180)}${start + 180 < selected.length ? "…" : ""}`;
}
