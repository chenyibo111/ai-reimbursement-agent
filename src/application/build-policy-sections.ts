import type { PolicyDocumentBlock } from "@/src/infrastructure/feishu/feishu-policy-document-client";

export type PolicySectionDraft = {
  sequence: number;
  headingPath: string[];
  content: string;
  sourceAnchor: string | null;
  complete: boolean;
};

const answerEvidenceLimit = 8_000;

export function buildPolicySections(blocks: PolicyDocumentBlock[]): PolicySectionDraft[] {
  const sections: PolicySectionDraft[] = [];
  const headings: string[] = [];
  const body: string[] = [];
  let anchor: string | null = null;
  function flush() {
    const content = body.join("\n").trim();
    if (content) sections.push({ sequence: sections.length, headingPath: [...headings], content, sourceAnchor: anchor, complete: content.length <= answerEvidenceLimit });
    body.length = 0;
  }
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    if (block.kind === "heading") {
      flush();
      const level = Math.max(1, Math.min(9, block.level ?? 1));
      headings.splice(level - 1, headings.length - level + 1, text);
      anchor = block.sourceBlockId ? `#${block.sourceBlockId}` : null;
    } else {
      body.push(text);
    }
  }
  flush();
  return sections;
}
