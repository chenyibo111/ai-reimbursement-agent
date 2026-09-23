import { NextResponse } from "next/server";

import { validateClaimForActor } from "@/src/application/validate-claim";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const prisma = getPrisma();
    const issues = await validateClaimForActor(actorId, claimId, {
      claims: {
        async getForValidation(id) {
          const claim = await prisma.claimDraft.findUnique({ where: { id }, include: { receipts: { select: { extractionPayload: true } }, expenseItems: true, validationResults: { where: { code: { in: ["DUPLICATE_FILE", "DUPLICATE_INVOICE"] }, resolvedAt: null } } } });
          if (!claim) throw new Error("claim not found");
          return { employeeId: claim.employeeId, status: claim.status, purpose: claim.purpose, expenseTotalCents: claim.expenseItems.reduce((total, item) => total + item.amountCents, 0), duplicate: claim.validationResults.length > 0, fields: extractedFields(claim.receipts.map((receipt) => receipt.extractionPayload)) };
        },
      },
    });
    return NextResponse.json({ issues });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "claim not found" ? 404 : 500 });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}

function extractedFields(payloads: unknown[]) {
  const fields: Record<string, { value: string | number | null; confidence: number; source: "EXTRACTED" }> = {};
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    for (const name of ["totalAmountCents", "issuedOn", "invoiceNumber"] as const) {
      const field = (payload as Record<string, unknown>)[name];
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const candidate = field as Record<string, unknown>;
      if ((typeof candidate.value !== "string" && typeof candidate.value !== "number" && candidate.value !== null) || typeof candidate.confidence !== "number" || candidate.source !== "EXTRACTED") continue;
      const existing = fields[name];
      if (!existing || candidate.confidence < existing.confidence) fields[name] = { value: candidate.value, confidence: candidate.confidence, source: "EXTRACTED" };
    }
  }
  return fields;
}
