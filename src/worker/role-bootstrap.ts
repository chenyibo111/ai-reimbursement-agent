import { createPrismaClient } from "@/src/infrastructure/prisma/client";

async function main() {
  const employeeId = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (!employeeId) throw new Error("employee id is required");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const prisma = createPrismaClient(databaseUrl);
  try {
    await prisma.$connect();
    const updated = await prisma.employee.updateMany({ where: { id: employeeId }, data: { role: "ADMIN" } });
    if (updated.count !== 1) throw new Error("employee not found");
    console.log(JSON.stringify({ employeeId, role: "ADMIN" }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error("Role bootstrap failed");
  process.exitCode = 1;
});
