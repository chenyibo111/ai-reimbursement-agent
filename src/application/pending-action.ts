export type PendingAction = {
  kind: "DELETE_RECEIPT";
  claimId: string;
  claimVersion: number;
  receiptId: string;
  expiresAt: string;
} | {
  kind: "DELETE_DRAFT";
  claimId: string;
  claimVersion: number;
  expiresAt: string;
};

export function readPendingAction(value: unknown, now = new Date()): PendingAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.kind !== "DELETE_RECEIPT" && action.kind !== "DELETE_DRAFT") return null;
  if (typeof action.claimId !== "string" || !action.claimId || !Number.isSafeInteger(action.claimVersion) || (action.claimVersion as number) < 1 || typeof action.expiresAt !== "string") return null;
  if (action.kind === "DELETE_RECEIPT" && (typeof action.receiptId !== "string" || !action.receiptId)) return null;
  const expiresAt = new Date(action.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return null;
  return action as PendingAction;
}
