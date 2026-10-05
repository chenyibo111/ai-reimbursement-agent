import { NextResponse } from "next/server";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { canManagePolicyReview, canReviewOcr } from "@/src/domain/async-job";
import { getReviewActor, reviewFailure } from "@/src/server/review-admin";

export const runtime = "nodejs";

type CorrectionField = "invoiceNumber" | "issuedOn" | "totalAmountCents";
type ResolveAction = "CONFIRM" | "CORRECT_FIELDS" | "REQUEST_INFORMATION" | "CLOSE";

export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  try {
    const { reviewId } = await context.params;
    const { actor, prisma } = await getReviewActor(request);
    const body = await request.json() as { action?: unknown; corrections?: unknown; expectedVersion?: unknown; message?: unknown };
    if (!isResolveAction(body.action)) throw new Error("invalid review resolution");
    const review = await prisma.reviewCase.findUnique({ where: { id: reviewId } });
    if (!review) throw new Error("review not found");
    if (!(review.kind === "RECEIPT_OCR" ? canReviewOcr(actor.role) : canManagePolicyReview(actor.role))) throw new Error("forbidden");
    if (review.status !== "CLAIMED") throw new Error("review is not actionable");
    if (review.assignedReviewerId !== actor.id && actor.role !== "ADMIN") throw new Error("forbidden");
    const corrections = parseCorrections(body.action, body.corrections);
    const expectedVersion = parseExpectedVersion(body.action, body.expectedVersion);
    const message = parseResolutionMessage(body.action, body.message);

    const resolved = await resolve(prisma, { reviewId, actorId: actor.id, action: body.action, corrections, expectedVersion, message });
    if (!resolved) throw new Error("review is not actionable");
    return NextResponse.json({ id: reviewId, status: "RESOLVED" });
  } catch (error) {
    return reviewFailure(error);
  }
}

async function resolve(prisma: PrismaClient, input: { reviewId: string; actorId: string; action: ResolveAction; corrections: Partial<Record<CorrectionField, string | number>>; expectedVersion: number | null; message: string | null }) {
  return prisma.$transaction(async (tx) => {
    const review = await tx.reviewCase.findUnique({ where: { id: input.reviewId } });
    if (!review || review.status !== "CLAIMED") return false;
    const updated = await tx.reviewCase.updateMany({
      where: { id: input.reviewId, status: "CLAIMED" },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolution: { action: input.action, corrections: input.corrections, message: input.message } as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) return false;

    if (Object.keys(input.corrections).length > 0) {
      if (!review.claimId || !review.receiptId) throw new Error("invalid review correction");
      const claim = await tx.claimDraft.updateMany({ where: { id: review.claimId, version: input.expectedVersion ?? -1 }, data: { version: { increment: 1 } } });
      if (claim.count !== 1) throw new Error("version conflict");
      let expense = await tx.expenseItem.findFirst({ where: { claimId: review.claimId, receiptId: review.receiptId }, select: { id: true } });
      if (!expense) {
        const totalAmountCents = input.corrections.totalAmountCents;
        if (typeof totalAmountCents !== "number") throw new Error("invalid review correction");
        expense = await tx.expenseItem.create({
          data: {
            claimId: review.claimId,
            receiptId: review.receiptId,
            amountCents: totalAmountCents,
            amountSource: "USER_ENTERED",
            invoiceNumber: typeof input.corrections.invoiceNumber === "string" ? input.corrections.invoiceNumber : null,
            invoiceSource: typeof input.corrections.invoiceNumber === "string" ? "USER_ENTERED" : null,
            issuedOn: typeof input.corrections.issuedOn === "string" ? new Date(input.corrections.issuedOn) : null,
            issuedOnSource: typeof input.corrections.issuedOn === "string" ? "USER_ENTERED" : null,
          },
          select: { id: true },
        });
      }
      for (const [field, value] of Object.entries(input.corrections) as Array<[CorrectionField, string | number]>) {
        if (expense) await tx.expenseItem.update({ where: { id: expense.id }, data: expensePatch(field, value) });
        await tx.auditEvent.create({ data: { claimId: review.claimId, actorId: input.actorId, type: "REVIEW_FIELD_CORRECTED", payload: { reviewId: review.id, expenseItemId: expense.id, field, value, source: "USER_ENTERED" } } });
      }
    }
    if (input.action === "REQUEST_INFORMATION") {
      if (!review.claimId || !input.message) throw new Error("invalid review request");
      await tx.clarification.create({ data: { claimId: review.claimId, field: "review", prompt: input.message } });
    }
    if (review.claimId) {
      await tx.auditEvent.create({ data: { claimId: review.claimId, actorId: input.actorId, type: "REVIEW_CASE_RESOLVED", payload: { reviewId: review.id, action: input.action } } });
    }
    await tx.asyncJob.updateMany({
      where: { id: review.jobId, status: "REVIEW_REQUIRED" },
      data: { status: input.action === "REQUEST_INFORMATION" || input.action === "CLOSE" ? "CLOSED" : "SUCCEEDED", leaseUntil: null },
    });
    return true;
  });
}

function isResolveAction(value: unknown): value is ResolveAction {
  return value === "CONFIRM" || value === "CORRECT_FIELDS" || value === "REQUEST_INFORMATION" || value === "CLOSE";
}

function parseCorrections(action: ResolveAction, value: unknown): Partial<Record<CorrectionField, string | number>> {
  if (action !== "CORRECT_FIELDS") {
    if (value !== undefined) throw new Error("invalid review resolution");
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid review correction");
  const raw = value as Record<string, unknown>;
  const result: Partial<Record<CorrectionField, string | number>> = {};
  if (raw.invoiceNumber !== undefined) {
    if (typeof raw.invoiceNumber !== "string" || !raw.invoiceNumber.trim()) throw new Error("invalid review correction");
    result.invoiceNumber = raw.invoiceNumber.trim();
  }
  if (raw.issuedOn !== undefined) {
    if (typeof raw.issuedOn !== "string" || Number.isNaN(new Date(raw.issuedOn).getTime())) throw new Error("invalid review correction");
    result.issuedOn = raw.issuedOn;
  }
  if (raw.totalAmountCents !== undefined) {
    if (typeof raw.totalAmountCents !== "number" || !Number.isInteger(raw.totalAmountCents) || raw.totalAmountCents < 0) throw new Error("invalid review correction");
    result.totalAmountCents = raw.totalAmountCents;
  }
  if (Object.keys(result).length === 0 || Object.keys(raw).some((key) => key !== "invoiceNumber" && key !== "issuedOn" && key !== "totalAmountCents")) throw new Error("invalid review correction");
  return result;
}

function parseExpectedVersion(action: ResolveAction, value: unknown): number | null {
  if (action !== "CORRECT_FIELDS") {
    if (value !== undefined) throw new Error("invalid review resolution");
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("invalid review correction");
  return value;
}

function parseResolutionMessage(action: ResolveAction, value: unknown): string | null {
  if (action !== "REQUEST_INFORMATION" && action !== "CLOSE") {
    if (value !== undefined) throw new Error("invalid review resolution");
    return null;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(action === "CLOSE" ? "invalid review closure" : "invalid review request");
  return value.trim();
}

function expensePatch(field: CorrectionField, value: string | number) {
  if (field === "invoiceNumber") return { invoiceNumber: value as string, invoiceSource: "USER_ENTERED" as const };
  if (field === "issuedOn") return { issuedOn: new Date(value as string), issuedOnSource: "USER_ENTERED" as const };
  return { amountCents: value as number, amountSource: "USER_ENTERED" as const };
}
