/**
 * Read-only legacy export. Run with DATABASE_URL pointing at the legacy Prisma
 * database and redirect stdout to a protected migration manifest.
 */
import { createPrismaClient } from "../../src/infrastructure/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const prisma = createPrismaClient(databaseUrl);
try {
  const claims = await prisma.claimDraft.findMany({
    where: { status: { in: ["DRAFT", "SUBMITTED"] } },
    include: { receipts: true, submissions: true },
    orderBy: { createdAt: "asc" },
  });
  for (const claim of claims) {
    process.stdout.write(`${JSON.stringify({
      claim: { id: claim.id, employeeId: claim.employeeId, status: claim.status, purpose: claim.purpose, version: claim.version, createdAt: claim.createdAt, updatedAt: claim.updatedAt },
      receipts: claim.receipts.map((receipt) => ({ id: receipt.id, claimId: receipt.claimId, contentHash: receipt.contentHash, mimeType: receipt.mimeType, status: receipt.status, originalFilename: receipt.originalFilename })),
      submissions: claim.submissions.map((submission) => ({ submissionNumber: submission.submissionNumber, claimVersion: submission.claimVersion, submittedAt: submission.submittedAt, payload: submission.payload })),
    })}\n`);
  }
} finally { await prisma.$disconnect(); }
