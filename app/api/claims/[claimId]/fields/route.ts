import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { updateClaimField } from "@/src/application/update-claim-field";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const body = (await request.json()) as { field?: unknown; value?: unknown; expectedVersion?: unknown; expenseItemId?: unknown };
    const { field, value, expectedVersion } = body;
    if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
      return NextResponse.json({ error: "invalid field update" }, { status: 400 });
    }
    const prisma = getPrisma();
    if (field === "invoiceNumber" || field === "issuedOn" || field === "totalAmountCents") {
      const expenseItemId = body.expenseItemId;
      if (typeof expenseItemId !== "string" || !expenseItemId || (field === "totalAmountCents" && (typeof value !== "number" || !Number.isInteger(value))) || (field !== "totalAmountCents" && typeof value !== "string")) {
        return NextResponse.json({ error: "invalid field update" }, { status: 400 });
      }
      const claims = new PrismaClaimRepository(prisma);
      const claim = await claims.getByIdOrThrow(claimId);
      if (claim.employeeId !== actorId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
      const expense = await prisma.expenseItem.findFirst({ where: { id: expenseItemId, claimId }, select: { id: true } });
      if (!expense) return NextResponse.json({ error: "expense item not found" }, { status: 404 });
      const updatedClaim = await claims.updateDraft(claimId, expectedVersion, {});
      const expenseValue = value as string | number;
      const updated = await prisma.expenseItem.updateMany({ where: { id: expenseItemId, claimId }, data: expensePatch(field, expenseValue) });
      if (updated.count !== 1) throw new Error("expense item update conflict");
      await createPrismaAuditEventWriter(prisma).append({ type: "CLAIM_FIELD_UPDATED", actorId, claimId, payload: { field, expenseItemId, source: "USER_ENTERED", value } });
      return NextResponse.json({ field, source: "USER_ENTERED", version: updatedClaim.version });
    }
    if (field !== "purpose" || typeof value !== "string") return NextResponse.json({ error: "invalid field update" }, { status: 400 });
    const result = await updateClaimField(
      { actorId, claimId, field: "purpose", value, expectedVersion },
      { claims: new PrismaClaimRepository(prisma), audit: createPrismaAuditEventWriter(prisma) },
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "version conflict" ? 409 : message === "purpose is required" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function expensePatch(field: "invoiceNumber" | "issuedOn" | "totalAmountCents", value: string | number) {
  if (field === "invoiceNumber") return { invoiceNumber: value as string, invoiceSource: "USER_ENTERED" as const };
  if (field === "issuedOn") return { issuedOn: new Date(value as string), issuedOnSource: "USER_ENTERED" as const };
  return { amountCents: value as number, amountSource: "USER_ENTERED" as const };
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
