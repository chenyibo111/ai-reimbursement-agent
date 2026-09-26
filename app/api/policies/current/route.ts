import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyRepository } from "@/src/infrastructure/prisma/policy-repository";
import { getSessionActorId } from "@/src/server/session";

export async function GET(request: Request) {
  try {
    getSessionActorId(request);
    const policy = await new PrismaPolicyRepository(db()).getCurrentPublished(new Date());
    return NextResponse.json({
      policy: policy ? {
        title: policy.title,
        version: policy.version,
        effectiveFrom: policy.effectiveFrom,
        rules: policy.rules.map((rule) => ({ code: rule.code, name: rule.name, type: rule.type, severity: rule.severity })),
      } : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : 500 });
  }
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
