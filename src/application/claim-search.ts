import type { ClaimSnapshot, OwnedClaimSearchPage, OwnedClaimSearchQuery } from "@/services/agent/src/ports/reimbursement-port";

export type ClaimSearchRequest = Partial<Omit<OwnedClaimSearchQuery, "limit" | "cursor">> & {
  period?: "THIS_MONTH" | "LAST_MONTH";
  requestedCount?: number;
};

export type ClaimSearchState = {
  query: Omit<OwnedClaimSearchQuery, "limit" | "cursor">;
  remaining: number;
  cursor: string | null;
  totalCount: number;
  expiresAt: string;
  lastPage: Array<{ ordinal: number; id: string; claimNumber: string }>;
};

const TTL_MS = 10 * 60_000;

export function normalizeClaimSearch(request: ClaimSearchRequest | undefined, now: Date): { query: ClaimSearchState["query"]; requestedCount: number } {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid claim search");
  const allowed = new Set(["status", "createdFrom", "createdBefore", "purposeContains", "expenseCategory", "minRequestedAmountCent", "maxRequestedAmountCent", "sort", "countOnly", "period", "requestedCount"]);
  if (Object.keys(request).some((field) => !allowed.has(field))) throw new Error("invalid claim search");
  const requestedCount = request.requestedCount ?? 5;
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 100) throw new Error("invalid claim search count");
  if (request.status !== undefined && request.status !== "DRAFT" && request.status !== "SUBMITTED") throw new Error("invalid claim status");
  if (request.sort !== undefined && !["created_desc", "created_asc", "amount_desc", "amount_asc"].includes(request.sort)) throw new Error("invalid claim sort");
  if (request.countOnly !== undefined && typeof request.countOnly !== "boolean") throw new Error("invalid countOnly");
  const query: ClaimSearchState["query"] = {};
  for (const field of ["status", "sort", "countOnly", "purposeContains", "expenseCategory", "minRequestedAmountCent", "maxRequestedAmountCent"] as const) {
    if (request[field] !== undefined) Object.assign(query, { [field]: request[field] });
  }
  for (const field of ["purposeContains", "expenseCategory"] as const) {
    if (query[field] !== undefined && (typeof query[field] !== "string" || query[field].trim().length > 200)) throw new Error(`invalid ${field}`);
  }
  for (const field of ["minRequestedAmountCent", "maxRequestedAmountCent"] as const) {
    if (query[field] !== undefined && (!Number.isSafeInteger(query[field]) || query[field] < 0)) throw new Error(`invalid ${field}`);
  }
  if (query.minRequestedAmountCent !== undefined && query.maxRequestedAmountCent !== undefined && query.minRequestedAmountCent > query.maxRequestedAmountCent) throw new Error("invalid amount range");
  if (request.period) {
    if (request.createdFrom || request.createdBefore || !["THIS_MONTH", "LAST_MONTH"].includes(request.period)) throw new Error("invalid period");
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" });
    const parts = formatter.formatToParts(now);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const start = new Date(Date.UTC(year, month - (request.period === "LAST_MONTH" ? 2 : 1), 1));
    const end = new Date(Date.UTC(year, month - (request.period === "LAST_MONTH" ? 1 : 0), 1));
    query.createdFrom = start.toISOString().slice(0, 10);
    query.createdBefore = end.toISOString().slice(0, 10);
  } else {
    for (const field of ["createdFrom", "createdBefore"] as const) {
      if (request[field] === undefined) continue;
      if (typeof request[field] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(request[field]) || Number.isNaN(Date.parse(request[field]))) throw new Error(`invalid ${field}`);
      query[field] = request[field];
    }
  }
  if (query.createdFrom && query.createdBefore && query.createdFrom >= query.createdBefore) throw new Error("invalid date range");
  return { query, requestedCount };
}

export function readClaimSearchState(value: unknown, now: Date): ClaimSearchState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Partial<ClaimSearchState>;
  if (!state.query || !Number.isInteger(state.remaining) || !Number.isSafeInteger(state.totalCount) || !Array.isArray(state.lastPage) || typeof state.expiresAt !== "string" || Date.parse(state.expiresAt) <= now.getTime()) return null;
  if (state.cursor !== null && typeof state.cursor !== "string") return null;
  if (state.lastPage.some((item) => !item || !Number.isInteger(item.ordinal) || typeof item.id !== "string" || typeof item.claimNumber !== "string")) return null;
  return state as ClaimSearchState;
}

export function formatClaimSearchPage(page: OwnedClaimSearchPage, query: ClaimSearchState["query"], requestedCount: number, now: Date): { reply: string; state: ClaimSearchState } {
  const items = page.items.slice(0, 10);
  const remaining = Math.max(0, requestedCount - items.length);
  const cursor = remaining > 0 ? page.nextCursor : null;
  const nextState: ClaimSearchState = {
    query, remaining: cursor ? remaining : 0, cursor, totalCount: page.totalCount,
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    lastPage: items.map((claim, index) => ({ ordinal: index + 1, id: claim.id, claimNumber: claim.claimNumber })),
  };
  const lines = items.map((claim, index) => formatClaimSearchLine(index + 1, claim));
  const heading = `查询时共 ${page.totalCount} 张本人报销单。`;
  const reply = page.totalCount === 0 ? `${heading}请调整条件后再查。` : `${heading}\n${lines.join("\n")}${cursor ? "\n回复“下一页”继续查看。" : ""}\n可回复序号查看当前页单据详情。`;
  return { reply: reply.slice(0, 1000), state: nextState };
}

function formatClaimSearchLine(index: number, claim: ClaimSnapshot): string {
  return `${index}. ${claim.claimNumber}｜${claim.status}｜${(claim.purpose || "未填写事由").slice(0, 24)}`;
}
