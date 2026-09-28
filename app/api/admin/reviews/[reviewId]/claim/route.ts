import { NextResponse } from "next/server";

import { claimReviewCase } from "@/src/application/review-case";
import { PrismaReviewCaseRepository } from "@/src/infrastructure/prisma/review-case-repository";
import { getReviewActor, reviewFailure } from "@/src/server/review-admin";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  try {
    const { reviewId } = await context.params;
    const { actor, prisma } = await getReviewActor(request);
    const review = await claimReviewCase({ actor, reviewId }, { reviews: new PrismaReviewCaseRepository(prisma) });
    return NextResponse.json(review);
  } catch (error) {
    return reviewFailure(error);
  }
}
