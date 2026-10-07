import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

type Record = { claim: { id: string; status: string }; receipts: { contentHash: string }[]; submissions: { submissionNumber: string }[] };
async function load(path: string) { const records = new Map<string, Record>(); for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) { if (line.trim()) { const row = JSON.parse(line) as Record; records.set(row.claim.id, row); } } return records; }
const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) throw new Error("usage: reconcile-claims <source.jsonl> <target.jsonl>");
const [source, target] = await Promise.all([load(sourcePath), load(targetPath)]);
const differences: { claimId: string; code: string }[] = [];
for (const [id, left] of source) { const right = target.get(id); if (!right) { differences.push({ claimId:id, code:"CLAIM_MISSING" }); continue; } if (left.claim.status !== right.claim.status) differences.push({ claimId:id, code:"STATUS_MISMATCH" }); const hashes = new Set(right.receipts.map((receipt) => receipt.contentHash)); for (const receipt of left.receipts) if (!hashes.has(receipt.contentHash)) differences.push({ claimId:id, code:"RECEIPT_HASH_MISSING" }); if ((left.submissions[0]?.submissionNumber ?? "") !== (right.submissions[0]?.submissionNumber ?? "")) differences.push({ claimId:id, code:"SUBMISSION_MISMATCH" }); }
for (const id of target.keys()) if (!source.has(id)) differences.push({ claimId:id, code:"UNEXPECTED_TARGET_CLAIM" });
process.stdout.write(`${JSON.stringify({ sourceCount: source.size, targetCount: target.size, differences })}\n`);
process.exitCode = differences.length ? 2 : 0;
