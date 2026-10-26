import type { PolicySectionDraft } from "@/src/application/build-policy-sections";

export type PolicyChunkDraft = { sequence: number; sectionSequence: number; headingPath: string[]; content: string; sourceAnchor: string | null };

export function splitPolicyDocument(sections: PolicySectionDraft[], options: { targetLength: number; maxLength: number }): PolicyChunkDraft[] {
  const chunks: PolicyChunkDraft[] = [];
  for (const section of sections) {
    let buffer = "";
    const flush = () => {
      if (!buffer.trim()) return;
      chunks.push({ sequence: chunks.length, sectionSequence: section.sequence, headingPath: section.headingPath, content: buffer.trim(), sourceAnchor: section.sourceAnchor });
      buffer = "";
    };
    for (const line of section.content.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      if (buffer && buffer.length + text.length + 1 > options.maxLength) flush();
      buffer = buffer ? `${buffer}\n${text}` : text;
      if (buffer.length >= options.targetLength) flush();
    }
    flush();
  }
  return chunks;
}
