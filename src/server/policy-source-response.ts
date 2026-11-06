type PolicySourceForResponse = {
  id: string;
  type: string;
  canonicalUrl: string;
  title: string;
  enabled: boolean;
  lastSuccessfulSyncAt: Date | null;
  lastFailureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  snapshots?: Array<{ _count: { sections: number; chunks: number } }>;
  asyncJobs?: Array<{ id: string; status: string; failureCode: string | null; result: unknown }>;
};

export function policySyncResultKind(result: unknown): "SYNCED" | "UNCHANGED" | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const status = (result as { status?: unknown }).status;
  return status === "SYNCED" || status === "UNCHANGED" ? status : null;
}

export function toPolicySourceResponse(source: PolicySourceForResponse) {
  const active = source.snapshots?.[0];
  return {
    id: source.id,
    type: source.type,
    canonicalUrl: source.canonicalUrl,
    title: source.title,
    enabled: source.enabled,
    lastSuccessfulSyncAt: source.lastSuccessfulSyncAt,
    lastFailureCode: source.lastFailureCode,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    sectionCount: active?._count.sections ?? null,
    chunkCount: active?._count.chunks ?? null,
    lastJob: source.asyncJobs?.[0] ? {
      jobId: source.asyncJobs[0].id,
      status: source.asyncJobs[0].status,
      failureCode: source.asyncJobs[0].failureCode,
      resultKind: policySyncResultKind(source.asyncJobs[0].result),
    } : null,
  };
}
