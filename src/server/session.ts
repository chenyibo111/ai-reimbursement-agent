import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const sessionCookieName = "reimbursement_session";
export const sessionDurationSeconds = 60 * 60 * 24 * 30;
type SessionPayload = { actorId: string; issuedAt: number; expiresAt: number; sessionId: string };

export function createSessionToken(actorId: string, secret: string, now = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = Buffer.from(JSON.stringify({ actorId, issuedAt, expiresAt: issuedAt + sessionDurationSeconds, sessionId: randomUUID() } satisfies SessionPayload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function getSessionActorId(request: Request, now = new Date()): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("session configuration is missing");
  }

  const token = readCookie(request.headers.get("cookie"), sessionCookieName);
  if (!token) {
    throw new Error("unauthenticated");
  }

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    throw new Error("unauthenticated");
  }

  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw new Error("unauthenticated");
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    const expiresAt = parsed.expiresAt;
    if (typeof parsed.actorId !== "string" || !parsed.actorId || !Number.isInteger(parsed.issuedAt) || !Number.isInteger(expiresAt) || typeof parsed.sessionId !== "string" || !parsed.sessionId || typeof expiresAt !== "number" || expiresAt <= Math.floor(now.getTime() / 1000)) {
      throw new Error("invalid actor");
    }
    return parsed.actorId;
  } catch {
    throw new Error("unauthenticated");
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const entry of header.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}
