export type PendingAction = {
  kind: "DELETE_RECEIPT";
  claimId: string;
  claimVersion: number;
  receiptId: string;
  expiresAt: string;
};

export function readPendingAction(value: unknown, now = new Date()): PendingAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.kind !== "DELETE_RECEIPT" || typeof action.claimId !== "string" || !action.claimId || typeof action.receiptId !== "string" || !action.receiptId || !Number.isSafeInteger(action.claimVersion) || (action.claimVersion as number) < 1 || typeof action.expiresAt !== "string") return null;
  const expiresAt = new Date(action.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return null;
  return action as PendingAction;
}
