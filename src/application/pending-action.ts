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
} | {
  kind: "SUBMIT";
  claimId: string;
  claimVersion: number;
  confirmationToken: string;
  preview: { claimNumber: string; purpose: string | null; requestedAmountCent: number | null; receiptCount: number };
  targetScope: "CURRENT_INTAKE" | "SELECTED_DRAFT" | "EXPLICIT_DRAFT";
  expiresAt: string;
};

export function readPendingAction(value: unknown, now = new Date()): PendingAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.kind !== "DELETE_RECEIPT" && action.kind !== "DELETE_DRAFT" && action.kind !== "SUBMIT") return null;
  if (typeof action.claimId !== "string" || !action.claimId || !Number.isSafeInteger(action.claimVersion) || (action.claimVersion as number) < 1 || typeof action.expiresAt !== "string") return null;
  if (action.kind === "DELETE_RECEIPT" && (typeof action.receiptId !== "string" || !action.receiptId)) return null;
  if (action.kind === "SUBMIT") {
    const preview = action.preview;
    if (typeof action.confirmationToken !== "string" || !action.confirmationToken ||
      (action.targetScope !== "CURRENT_INTAKE" && action.targetScope !== "SELECTED_DRAFT" && action.targetScope !== "EXPLICIT_DRAFT") ||
      !preview || typeof preview !== "object" || Array.isArray(preview) ||
      typeof (preview as Record<string, unknown>).claimNumber !== "string" ||
      !(preview as Record<string, unknown>).claimNumber ||
      !Number.isSafeInteger((preview as Record<string, unknown>).receiptCount) ||
      ((preview as Record<string, unknown>).receiptCount as number) < 0 ||
      ((preview as Record<string, unknown>).requestedAmountCent !== null && !Number.isSafeInteger((preview as Record<string, unknown>).requestedAmountCent)) ||
      ((preview as Record<string, unknown>).purpose !== null && typeof (preview as Record<string, unknown>).purpose !== "string")) return null;
  }
  const expiresAt = new Date(action.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return null;
  return action as PendingAction;
}
