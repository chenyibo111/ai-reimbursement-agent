import type { Prisma, PrismaClient, PolicyRuleType, ValidationSeverity } from "@/generated/prisma/client";

export type PolicyRuleDraft = {
  code: string;
  name: string;
  type: PolicyRuleType;
  severity: ValidationSeverity;
  config: Prisma.InputJsonValue;
  sortOrder: number;
};

export type PolicyVersionRecord = {
  id: string;
  title: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  version: number;
  effectiveFrom: Date;
  rules: Array<{
    id: string;
    code: string;
    name: string;
    type: PolicyRuleType;
    severity: ValidationSeverity;
    config: Prisma.JsonValue;
    enabled: boolean;
    sortOrder: number;
  }>;
};

export class PrismaPolicyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createDraft(input: { title: string; actorId: string; effectiveFrom: Date }): Promise<PolicyVersionRecord> {
    const draft = await this.prisma.$transaction(async (tx) => {
      const created = await tx.policyVersion.create({
        data: {
          title: input.title.trim(),
          effectiveFrom: input.effectiveFrom,
          createdByEmployeeId: input.actorId,
        },
        include: { rules: { orderBy: { sortOrder: "asc" } } },
      });
      await tx.policyAuditEvent.create({ data: { policyVersionId: created.id, actorId: input.actorId, type: "POLICY_VERSION_DRAFT_CREATED", payload: {} } });
      return created;
    });
    return toRecord(draft);
  }

  async replaceDraftRules(input: { policyVersionId: string; actorId: string; expectedVersion: number; rules: PolicyRuleDraft[] }): Promise<PolicyVersionRecord> {
    const draft = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.policyVersion.findUnique({ where: { id: input.policyVersionId } });
      if (!existing) throw new Error("policy version not found");
      if (existing.status !== "DRAFT") throw new Error("policy version is not draft");
      const updated = await tx.policyVersion.updateMany({
        where: { id: input.policyVersionId, status: "DRAFT", version: input.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new Error("version conflict");
      await tx.policyRule.deleteMany({ where: { policyVersionId: input.policyVersionId } });
      if (input.rules.length) {
        await tx.policyRule.createMany({
          data: input.rules.map((rule) => ({ ...rule, policyVersionId: input.policyVersionId })),
        });
      }
      await tx.policyAuditEvent.create({ data: { policyVersionId: input.policyVersionId, actorId: input.actorId, type: "POLICY_RULES_REPLACED", payload: { ruleCount: input.rules.length } } });
      return tx.policyVersion.findUniqueOrThrow({ where: { id: input.policyVersionId }, include: { rules: { orderBy: { sortOrder: "asc" } } } });
    });
    return toRecord(draft);
  }

  async publish(input: { policyVersionId: string; actorId: string; expectedVersion: number; now: Date }): Promise<PolicyVersionRecord> {
    const published = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.policyVersion.findUnique({ where: { id: input.policyVersionId } });
      if (!existing) throw new Error("policy version not found");
      if (existing.status !== "DRAFT") throw new Error("policy version is not draft");
      const updated = await tx.policyVersion.updateMany({
        where: { id: input.policyVersionId, status: "DRAFT", version: input.expectedVersion },
        data: { status: "PUBLISHED", version: { increment: 1 }, publishedAt: input.now, publishedByEmployeeId: input.actorId },
      });
      if (updated.count !== 1) throw new Error("version conflict");
      await tx.policyVersion.updateMany({
        where: { id: { not: input.policyVersionId }, status: "PUBLISHED" },
        data: { status: "ARCHIVED" },
      });
      await tx.policyAuditEvent.create({ data: { policyVersionId: input.policyVersionId, actorId: input.actorId, type: "POLICY_VERSION_PUBLISHED", payload: {} } });
      return tx.policyVersion.findUniqueOrThrow({ where: { id: input.policyVersionId }, include: { rules: { orderBy: { sortOrder: "asc" } } } });
    });
    return toRecord(published);
  }

  async getCurrentPublished(now: Date): Promise<PolicyVersionRecord | null> {
    const version = await this.prisma.policyVersion.findFirst({
      where: { status: "PUBLISHED", effectiveFrom: { lte: now } },
      orderBy: [{ effectiveFrom: "desc" }, { publishedAt: "desc" }],
      include: { rules: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } },
    });
    return version ? toRecord(version) : null;
  }
}

function toRecord(version: {
  id: string;
  title: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  version: number;
  effectiveFrom: Date;
  rules: Array<{ id: string; code: string; name: string; type: PolicyRuleType; severity: ValidationSeverity; config: Prisma.JsonValue; enabled: boolean; sortOrder: number }>;
}): PolicyVersionRecord {
  return version;
}
