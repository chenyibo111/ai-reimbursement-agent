import type { PolicyDocumentBlock } from "@/src/infrastructure/feishu/feishu-policy-document-client";

export function splitPolicyDocument(blocks: PolicyDocumentBlock[], options: { maxLength: number; minLength: number }) {
  const headingPath: string[] = [];
  const chunks: Array<{ content: string; headingPath: string[] }> = [];
  let buffer = "";
  const flush = () => { if (buffer.trim()) chunks.push({ content: buffer.trim(), headingPath: [...headingPath] }); buffer = ""; };
  for (const block of blocks) {
    if (block.kind === "heading") { flush(); headingPath.splice(0, headingPath.length, block.text.trim()); continue; }
    const text = block.text.trim();
    if (!text) continue;
    if (buffer && buffer.length + text.length + 1 > options.maxLength) flush();
    buffer = buffer ? `${buffer}\n${text}` : text;
    if (buffer.length >= options.minLength) flush();
  }
  flush();
  return chunks;
}
