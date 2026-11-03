import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type SsoSessionRecord = {
  idHash: string;
  employeeId: string;
  sid: string;
  encryptedIdToken: string;
  expiresAt: Date;
};

export type SsoSessionRepository = {
  find(idHash: string): Promise<SsoSessionRecord | null>;
  put(record: SsoSessionRecord): Promise<void>;
  deleteBySid(sid: string): Promise<void>;
};

export class SsoSessionError extends Error {
  constructor(public readonly code: "UNAUTHENTICATED" | "UNAVAILABLE") {
    super(code);
  }
}

export function createSsoWebSessionService(input: {
  repository: SsoSessionRepository;
  secret: string;
  checkStatus(idToken: string): Promise<number>;
  now?: () => Date;
}) {
  if (!input.secret) throw new Error("SSO session secret is required");
  const key = createHash("sha256").update("reimbursement-sso-id-token:\0").update(input.secret).digest();
  const now = input.now ?? (() => new Date());

  return {
    async create(session: { employeeId: string; sid: string; idToken: string; expiresAt: Date }): Promise<string> {
      if (!session.employeeId || !session.sid || !session.idToken || session.expiresAt <= now()) throw new Error("invalid SSO session");
      const cookie = randomBytes(32).toString("base64url");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(session.idToken, "utf8"), cipher.final()]);
      const encryptedIdToken = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
      await input.repository.put({ idHash: hashCookie(cookie), employeeId: session.employeeId, sid: session.sid, encryptedIdToken, expiresAt: session.expiresAt });
      return cookie;
    },
    async active(cookie: string): Promise<{ employeeId: string; sid: string; idToken: string }> {
      if (!cookie || Buffer.from(cookie, "base64url").length !== 32) throw new SsoSessionError("UNAUTHENTICATED");
      let record: SsoSessionRecord | null;
      try {
        record = await input.repository.find(hashCookie(cookie));
      } catch {
        throw new SsoSessionError("UNAVAILABLE");
      }
      if (!record || record.expiresAt <= now()) throw new SsoSessionError("UNAUTHENTICATED");
      let idToken: string;
      try {
        const encrypted = Buffer.from(record.encryptedIdToken, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        idToken = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8");
      } catch {
        throw new SsoSessionError("UNAUTHENTICATED");
      }
      let status: number;
      try {
        status = await input.checkStatus(idToken);
      } catch {
        throw new SsoSessionError("UNAVAILABLE");
      }
      if (status === 401) throw new SsoSessionError("UNAUTHENTICATED");
      if (status !== 204) throw new SsoSessionError("UNAVAILABLE");
      return { employeeId: record.employeeId, sid: record.sid, idToken };
    },
    deleteBySid: input.repository.deleteBySid,
  };
}

function hashCookie(cookie: string): string {
  return createHash("sha256").update(cookie).digest("hex");
}
