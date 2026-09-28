import { NextResponse } from "next/server";

import { canManagePolicyReview } from "@/src/domain/async-job";
import { getReviewActor, reviewFailure } from "@/src/server/review-admin";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  try {
    const { reviewId } = await context.params;
    const { actor, prisma } = await getReviewActor(request);
    const review = await prisma.reviewCase.findUnique({ where: { id: reviewId } });
    if (!review) throw new Error("review not found");
    if (review.kind !== "POLICY_SYNC" || !canManagePolicyReview(actor.role)) throw new Error("forbidden");
    const retried = await prisma.$transaction(async (tx) => {
      const job = await tx.asyncJob.updateMany({
        where: { id: review.jobId, kind: "POLICY_SOURCE_SYNC", status: "REVIEW_REQUIRED" },
        data: { status: "PENDING", availableAt: new Date(), leaseUntil: null, failureCode: null },
      });
      if (job.count !== 1) return false;
      const resolved = await tx.reviewCase.updateMany({
        where: { id: review.id, status: { in: ["OPEN", "CLAIMED"] } },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolution: { action: "RETRY", actorId: actor.id } },
      });
      return resolved.count === 1;
    });
    if (!retried) throw new Error("review is not actionable");
    return NextResponse.json({ id: review.id, status: "RESOLVED", jobStatus: "PENDING" }, { status: 202 });
  } catch (error) {
    return reviewFailure(error);
  }
}
