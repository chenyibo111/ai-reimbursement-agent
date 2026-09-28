import type { PrismaClient } from "@/generated/prisma/client";

export class PrismaReviewCaseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getById(reviewId: string) {
    return this.prisma.reviewCase.findUnique({ where: { id: reviewId } });
  }

  async claimOpen(input: { reviewId: string; reviewerId: string }): Promise<boolean> {
    const claimed = await this.prisma.reviewCase.updateMany({
      where: {
        id: input.reviewId,
        status: "OPEN",
        assignedReviewerId: null,
      },
      data: {
        status: "CLAIMED",
        assignedReviewerId: input.reviewerId,
        claimedAt: new Date(),
      },
    });
    return claimed.count === 1;
  }
}
