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
};

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
  };
}
