import { canManagePolicyReview, canReviewOcr, type EmployeeRoleName } from "@/src/domain/async-job";

type ReviewCaseRecord = { id: string; kind: "RECEIPT_OCR" | "POLICY_SYNC"; status: string; assignedReviewerId: string | null };

export async function claimReviewCase(
  input: { actor: { id: string; role: EmployeeRoleName }; reviewId: string },
  deps: { reviews: { getById(id: string): Promise<ReviewCaseRecord | null>; claimOpen(input: { reviewId: string; reviewerId: string }): Promise<boolean> } },
) {
  const review = await deps.reviews.getById(input.reviewId);
  if (!review) throw new Error("review not found");
  const allowed = review.kind === "RECEIPT_OCR" ? canReviewOcr(input.actor.role) : canManagePolicyReview(input.actor.role);
  if (!allowed) throw new Error("forbidden");
  if (review.status !== "OPEN" || !(await deps.reviews.claimOpen({ reviewId: review.id, reviewerId: input.actor.id }))) throw new Error("review already claimed");
  return { id: review.id, status: "CLAIMED" as const };
}
