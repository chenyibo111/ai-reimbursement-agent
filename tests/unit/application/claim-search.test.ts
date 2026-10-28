import { expect, it } from "vitest";

import { normalizeClaimSearch, readClaimSearchState } from "@/src/application/claim-search";

it("resolves last month in Asia/Shanghai and refuses invalid filters", () => {
  const now = new Date("2026-10-26T02:00:00Z");
  expect(normalizeClaimSearch({ period: "LAST_MONTH", status: "DRAFT", requestedCount: 12 }, now)).toEqual({
    requestedCount: 12,
    query: { status: "DRAFT", createdFrom: "2026-09-01", createdBefore: "2026-10-01" },
  });
  expect(() => normalizeClaimSearch(undefined, now)).toThrow();
  expect(() => normalizeClaimSearch({ requestedCount: 101 }, now)).toThrow();
  expect(() => normalizeClaimSearch({ status: "UNKNOWN" as "DRAFT" }, now)).toThrow();
  expect(() => normalizeClaimSearch({ period: "LAST_MONTH", createdFrom: "2026-09-01" }, now)).toThrow();
  expect(() => normalizeClaimSearch({ minRequestedAmountCent: 500, maxRequestedAmountCent: 100 }, now)).toThrow();
});

it("expires a displayed page before an ordinal can be reused", () => {
  expect(readClaimSearchState({ query: {}, remaining: 2, cursor: "next", totalCount: 12, expiresAt: "2026-10-26T00:00:00Z", lastPage: [{ ordinal: 2, id: "claim-2", claimNumber: "BX20261026-0002" }] }, new Date("2026-10-26T00:01:00Z"))).toBeNull();
});
