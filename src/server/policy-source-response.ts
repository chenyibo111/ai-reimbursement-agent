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
};

export function toPolicySourceResponse(source: PolicySourceForResponse) {
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
  };
}
