import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { sessionCookie } from "@/src/server/auth-cookies";

export const runtime = "nodejs";

export async function POST(_request: Request) {
  if (isProduction()) return NextResponse.json({ error: "not found" }, { status: 404 });

  const employeeId = process.env.DEV_DEMO_EMPLOYEE_ID;
  const displayName = process.env.DEV_DEMO_EMPLOYEE_NAME;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!employeeId || !displayName || !sessionSecret) {
    return NextResponse.json({ error: "development login is not configured" }, { status: 503 });
  }

  try {
    const prisma = getPrisma();
    const employee = await prisma.employee.upsert({
      where: { id: employeeId },
      update: { displayName },
      create: { id: employeeId, displayName },
    });
    const response = NextResponse.json({ employeeId: employee.id });
    response.headers.append("Set-Cookie", sessionCookie(employee.id, sessionSecret, false));
    return response;
  } catch {
    return NextResponse.json({ error: "development login failed" }, { status: 500 });
  }
}

function getPrisma() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database configuration is missing");
  return createPrismaClient(connectionString);
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}
