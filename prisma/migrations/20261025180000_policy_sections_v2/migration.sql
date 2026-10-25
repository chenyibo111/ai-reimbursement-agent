ALTER TABLE "PolicyDocumentSnapshot" ADD COLUMN "indexVersion" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "PolicyDocumentSnapshot_sourceId_sourceRevision_key";
CREATE UNIQUE INDEX "PolicyDocumentSnapshot_sourceId_sourceRevision_indexVersion_key" ON "PolicyDocumentSnapshot"("sourceId", "sourceRevision", "indexVersion");

CREATE TABLE "PolicySection" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "content" TEXT NOT NULL,
    "sourceAnchor" TEXT,
    "complete" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicySection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PolicySection_snapshotId_sequence_key" ON "PolicySection"("snapshotId", "sequence");
CREATE INDEX "PolicySection_snapshotId_sequence_idx" ON "PolicySection"("snapshotId", "sequence");
ALTER TABLE "PolicySection" ADD CONSTRAINT "PolicySection_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PolicyDocumentSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyChunk" ADD COLUMN "sectionId" TEXT;
CREATE INDEX "PolicyChunk_sectionId_idx" ON "PolicyChunk"("sectionId");
ALTER TABLE "PolicyChunk" ADD CONSTRAINT "PolicyChunk_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "PolicySection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
