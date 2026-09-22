import type { PrismaClient } from "@/generated/prisma/client";
import type { Claim, ClaimStatus } from "@/src/domain/claim";

export type CreateClaimDraft = {
  employeeId: string;
  purpose: string | null;
  status: ClaimStatus;
};

export type ClaimDraftPatch = Partial<Pick<Claim, "purpose" | "status">>;

export class PrismaClaimRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateClaimDraft): Promise<Claim> {
    const draft = await this.prisma.claimDraft.create({
      data: input,
    });

    return toClaim(draft);
  }

  async getByIdOrThrow(id: string): Promise<Claim> {
    const draft = await this.prisma.claimDraft.findUnique({ where: { id } });
    if (!draft) {
      throw new Error("claim not found");
    }

    return toClaim(draft);
  }

  async updateDraft(id: string, expectedVersion: number, patch: ClaimDraftPatch): Promise<Claim> {
    const updated = await this.prisma.claimDraft.updateMany({
      where: {
        id,
        version: expectedVersion,
        status: { not: "SUBMITTED" },
      },
      data: {
        ...patch,
        version: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      throw new Error("version conflict");
    }

    return this.getByIdOrThrow(id);
  }
}

function toClaim(draft: {
  id: string;
  employeeId: string;
  status: ClaimStatus;
  purpose: string | null;
  version: number;
}): Claim {
  return {
    id: draft.id,
    employeeId: draft.employeeId,
    status: draft.status,
    purpose: draft.purpose,
    version: draft.version,
  };
}
