import { randomUUID } from "node:crypto";

import { validateStoredClaimWithPolicy } from "@/src/application/validate-policy-claim";
import type { PolicyValidationIssue } from "@/src/domain/policy-rule-engine";
import type { PrismaClient } from "@/generated/prisma/client";
import { createConfirmationToken, readConfirmationToken } from "@/src/server/confirmation";

export class StoredSubmissionValidationError extends Error {
  constructor(readonly issues: ReturnType<typeof validateStoredClaimWithPolicy>) {
    super("claim has blocking validation issues");
  }
}

export async function requestStoredSubmission(input: { prisma: PrismaClient; actorId: string; claimId: string }) {
  const claim = await input.prisma.claimDraft.findUnique({
    where: { id: input.claimId },
    include: { receipts: { select: { id: true, extractionPayload: true } }, expenseItems: true, validationResults: { where: { code: { in: ["DUPLICATE_FILE", "DUPLICATE_INVOICE"] }, resolvedAt: null } } },
  });
  if (!claim) throw new Error("claim not found");
  if (claim.employeeId !== input.actorId) throw new Error("forbidden");
  const policy = await input.prisma.policyVersion.findFirst({ where: { status: "PUBLISHED", effectiveFrom: { lte: new Date() } }, orderBy: [{ effectiveFrom: "desc" }, { publishedAt: "desc" }], include: { rules: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } } });
  const issues = validateStoredClaimWithPolicy(claim, policy);
  if (issues.some((issue) => issue.severity === "BLOCKING")) throw new StoredSubmissionValidationError(issues);
  return {
    token: createConfirmationToken({ claimId: claim.id, version: claim.version, actorId: input.actorId }),
    claimId: claim.id,
    claimVersion: claim.version,
    totalAmountCents: claim.expenseItems.reduce((sum, item) => sum + item.amountCents, 0),
    receiptCount: claim.expenseItems.length,
    purpose: claim.purpose,
    issues,
  };
}

export async function submitStoredClaim(input: { prisma: PrismaClient; actorId: string; claimId: string; confirmationToken: string }) {
  const confirmation = readConfirmationToken(input.confirmationToken);
  if (!confirmation || confirmation.claimId !== input.claimId || confirmation.actorId !== input.actorId) throw new Error("invalid confirmation");
  return input.prisma.$transaction(async (tx) => {
    const claim = await tx.claimDraft.findUnique({
      where: { id: input.claimId },
      include: { receipts: { select: { id: true, extractionPayload: true } }, expenseItems: true, validationResults: { where: { code: { in: ["DUPLICATE_FILE", "DUPLICATE_INVOICE"] }, resolvedAt: null } } },
    });
    if (!claim || claim.employeeId !== input.actorId) throw new Error("forbidden");
    if (claim.version !== confirmation.version) throw new Error("confirmation is stale");
    const policy = await tx.policyVersion.findFirst({ where: { status: "PUBLISHED", effectiveFrom: { lte: new Date() } }, orderBy: [{ effectiveFrom: "desc" }, { publishedAt: "desc" }], include: { rules: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } } });
    const issues = validateStoredClaimWithPolicy(claim, policy);
    if (issues.some((issue) => issue.severity === "BLOCKING")) throw new StoredSubmissionValidationError(issues);
    const updated = await tx.claimDraft.updateMany({ where: { id: claim.id, version: claim.version, status: { not: "SUBMITTED" } }, data: { status: "SUBMITTED", version: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("confirmation is stale");
    const snapshot = await tx.submissionSnapshot.create({
      data: {
        claimId: claim.id,
        claimVersion: claim.version,
        submissionNumber: `RB${new Date().getFullYear()}${randomUUID().replaceAll("-", "").slice(0, 10)}`,
        payload: {
          purpose: claim.purpose,
          totalAmountCents: claim.expenseItems.reduce((sum, item) => sum + item.amountCents, 0),
          expenseItems: claim.expenseItems,
          policy: policy ? { id: policy.id, title: policy.title, version: policy.version, effectiveFrom: policy.effectiveFrom.toISOString(), ruleResults: issues.filter((issue): issue is PolicyValidationIssue => isPolicyValidationIssue(issue) && issue.policyVersionId === policy.id).map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message, ruleCode: issue.ruleCode })) } : null,
        },
      },
    });
    await tx.auditEvent.create({ data: { claimId: claim.id, actorId: input.actorId, type: "CLAIM_SUBMITTED", payload: { submissionNumber: snapshot.submissionNumber } } });
    return snapshot;
  });
}

function isPolicyValidationIssue(issue: ReturnType<typeof validateStoredClaimWithPolicy>[number]): issue is PolicyValidationIssue {
  return "policyVersionId" in issue && "ruleCode" in issue && "message" in issue;
}
