import { createHmac, timingSafeEqual } from "node:crypto";

const sessionCookieName = "reimbursement_session";

export function createSessionToken(actorId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ actorId }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function getSessionActorId(request: Request): string {
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
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { actorId?: unknown };
    if (typeof parsed.actorId !== "string" || !parsed.actorId) {
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
