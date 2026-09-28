import { NextResponse } from "next/server";

import { canReviewOcr } from "@/src/domain/async-job";
import { getReviewActor, reviewFailure } from "@/src/server/review-admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { actor, prisma } = await getReviewActor(request);
    if (!canReviewOcr(actor.role)) throw new Error("forbidden");
    const reviews = await prisma.reviewCase.findMany({
      where: actor.role === "ADMIN" ? undefined : { kind: "RECEIPT_OCR" },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      include: {
        job: { select: { id: true, kind: true, status: true, failureCode: true } },
        claim: { select: { id: true, employeeId: true, purpose: true, version: true } },
        receipt: { select: { id: true, originalFilename: true, status: true } },
        policySource: { select: { id: true, title: true } },
        assignedReviewer: { select: { id: true, displayName: true } },
      },
    });
    return NextResponse.json({ actor, reviews });
  } catch (error) {
    return reviewFailure(error);
  }
}
