import Link from "next/link";
import { cookies } from "next/headers";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export async function ReviewCenterNavigation() {
  try {
    if (!process.env.DATABASE_URL) return null;
    const token = (await cookies()).get("reimbursement_session")?.value;
    if (!token) return null;
    const actorId = getSessionActorId(new Request("http://localhost", { headers: { cookie: `reimbursement_session=${token}` } }));
    const prisma = createPrismaClient(process.env.DATABASE_URL);
    const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { role: true } });
    if (employee?.role !== "FINANCE_REVIEWER" && employee?.role !== "ADMIN") return null;
    return <nav className="review-navigation" aria-label="复核导航"><Link href="/admin/reviews">复核中心</Link></nav>;
  } catch {
    return null;
  }
}
