import { expect, it } from "vitest";

import { claimReviewCase } from "@/src/application/review-case";

it("rejects an employee who tries to claim an OCR review case", async () => {
  await expect(claimReviewCase(
    { actor: { id: "employee", role: "EMPLOYEE" }, reviewId: "review-1" },
    { reviews: { getById: async () => ({ id: "review-1", kind: "RECEIPT_OCR", status: "OPEN", assignedReviewerId: null }), claimOpen: async () => true } },
  )).rejects.toThrow("forbidden");
});

it("lets a finance reviewer claim an open OCR review exactly once", async () => {
  let status = "OPEN";
  await expect(claimReviewCase(
    { actor: { id: "reviewer", role: "FINANCE_REVIEWER" }, reviewId: "review-1" },
    { reviews: {
      getById: async () => ({ id: "review-1", kind: "RECEIPT_OCR", status, assignedReviewerId: null }),
      claimOpen: async () => { if (status !== "OPEN") return false; status = "CLAIMED"; return true; },
    } },
  )).resolves.toEqual({ id: "review-1", status: "CLAIMED" });
});

it("keeps policy sync review cases restricted to administrators", async () => {
  await expect(claimReviewCase(
    { actor: { id: "reviewer", role: "FINANCE_REVIEWER" }, reviewId: "policy-review" },
    { reviews: { getById: async () => ({ id: "policy-review", kind: "POLICY_SYNC", status: "OPEN", assignedReviewerId: null }), claimOpen: async () => true } },
  )).rejects.toThrow("forbidden");
});
