CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "PolicySourceType" AS ENUM ('FEISHU_DOCX', 'FEISHU_WIKI');
CREATE TYPE "PolicySnapshotStatus" AS ENUM ('STAGED', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "PolicySource" (
    "id" TEXT NOT NULL,
    "type" "PolicySourceType" NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "resourceToken" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByEmployeeId" TEXT NOT NULL,
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolicySource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyDocumentSnapshot" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "PolicySnapshotStatus" NOT NULL DEFAULT 'STAGED',
    "sourceRevision" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    CONSTRAINT "PolicyDocumentSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyChunk" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "content" TEXT NOT NULL,
    "sourceAnchor" TEXT,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PolicySource_canonicalUrl_key" ON "PolicySource"("canonicalUrl");
CREATE UNIQUE INDEX "PolicySource_resourceToken_key" ON "PolicySource"("resourceToken");
CREATE INDEX "PolicySource_enabled_updatedAt_idx" ON "PolicySource"("enabled", "updatedAt");
CREATE UNIQUE INDEX "PolicyDocumentSnapshot_sourceId_sourceRevision_key" ON "PolicyDocumentSnapshot"("sourceId", "sourceRevision");
CREATE INDEX "PolicyDocumentSnapshot_sourceId_status_createdAt_idx" ON "PolicyDocumentSnapshot"("sourceId", "status", "createdAt");
CREATE UNIQUE INDEX "PolicyChunk_snapshotId_sequence_key" ON "PolicyChunk"("snapshotId", "sequence");
CREATE INDEX "PolicyChunk_snapshotId_sequence_idx" ON "PolicyChunk"("snapshotId", "sequence");
CREATE INDEX "PolicyChunk_embedding_hnsw_idx" ON "PolicyChunk" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "PolicyDocumentSnapshot" ADD CONSTRAINT "PolicyDocumentSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "PolicySource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyChunk" ADD CONSTRAINT "PolicyChunk_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PolicyDocumentSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
