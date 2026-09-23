import { createHmac, timingSafeEqual } from "node:crypto";

export function createConfirmationToken(input: { claimId: string; version: number; actorId: string }): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("session configuration is missing");
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function readConfirmationToken(token: string): { claimId: string; version: number; actorId: string } | null {
  const secret = process.env.SESSION_SECRET;
  const [payload, signature] = token.split(".");
  if (!secret || !payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) return null;
  try { const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>; return typeof value.claimId === "string" && typeof value.actorId === "string" && typeof value.version === "number" ? { claimId: value.claimId, actorId: value.actorId, version: value.version } : null; } catch { return null; }
}
