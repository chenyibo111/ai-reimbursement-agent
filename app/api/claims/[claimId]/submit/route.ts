import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { validateStoredClaimWithPolicy } from "@/src/application/validate-policy-claim";
import type { PolicyValidationIssue } from "@/src/domain/policy-rule-engine";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { readConfirmationToken } from "@/src/server/confirmation";
import { getSessionActorId } from "@/src/server/session";

class BlockingValidationError extends Error {
  constructor(readonly issues: ReturnType<typeof validateStoredClaimWithPolicy>) {
    super("claim has blocking validation issues");
  }
}

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const body = await request.json() as { confirmationToken?: unknown };
    if (typeof body.confirmationToken !== "string") throw new Error("invalid confirmation");

    const confirmation = readConfirmationToken(body.confirmationToken);
    if (!confirmation || confirmation.claimId !== claimId || confirmation.actorId !== actorId) throw new Error("invalid confirmation");

    const result = await db().$transaction(async (tx) => {
      const claim = await tx.claimDraft.findUnique({
        where: { id: claimId },
        include: {
          receipts: { select: { id: true, extractionPayload: true } },
          expenseItems: true,
          validationResults: { where: { code: { in: ["DUPLICATE_FILE", "DUPLICATE_INVOICE"] }, resolvedAt: null } },
        },
      });
      if (!claim || claim.employeeId !== actorId) throw new Error("forbidden");
      if (claim.version !== confirmation.version) throw new Error("confirmation is stale");

      const policy = await tx.policyVersion.findFirst({
        where: { status: "PUBLISHED", effectiveFrom: { lte: new Date() } },
        orderBy: [{ effectiveFrom: "desc" }, { publishedAt: "desc" }],
        include: { rules: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } },
      });
      const issues = validateStoredClaimWithPolicy(claim, policy);
      if (issues.some((issue) => issue.severity === "BLOCKING")) throw new BlockingValidationError(issues);

      const updated = await tx.claimDraft.updateMany({
        where: { id: claimId, version: claim.version, status: { not: "SUBMITTED" } },
        data: { status: "SUBMITTED", version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new Error("confirmation is stale");

      const totalAmountCents = claim.expenseItems.reduce((sum, item) => sum + item.amountCents, 0);
      const snapshot = await tx.submissionSnapshot.create({
        data: {
          claimId,
          claimVersion: claim.version,
          submissionNumber: `RB${new Date().getFullYear()}${randomUUID().replaceAll("-", "").slice(0, 10)}`,
          payload: {
            purpose: claim.purpose,
            totalAmountCents,
            expenseItems: claim.expenseItems,
            policy: policy ? {
              id: policy.id,
              title: policy.title,
              version: policy.version,
              effectiveFrom: policy.effectiveFrom.toISOString(),
              ruleResults: issues
                .filter((issue): issue is PolicyValidationIssue => isPolicyValidationIssue(issue) && issue.policyVersionId === policy.id)
                .map((issue) => ({
                  code: issue.code,
                  severity: issue.severity,
                  message: issue.message,
                  ruleCode: issue.ruleCode,
                })),
            } : null,
          },
        },
      });
      await tx.auditEvent.create({ data: { claimId, actorId, type: "CLAIM_SUBMITTED", payload: { submissionNumber: snapshot.submissionNumber } } });
      return snapshot;
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BlockingValidationError) {
      return NextResponse.json({ error: "请先处理提交前检查中的阻断项。", issues: error.issues }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, {
      status: message === "confirmation is stale" ? 409 : message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : 400,
    });
  }
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}

function isPolicyValidationIssue(issue: ReturnType<typeof validateStoredClaimWithPolicy>[number]): issue is PolicyValidationIssue {
  return "policyVersionId" in issue && "ruleCode" in issue && "message" in issue;
}
