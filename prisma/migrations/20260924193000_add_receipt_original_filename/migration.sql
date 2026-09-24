-- Preserve the employee-facing attachment name separately from the private object key.
ALTER TABLE "Receipt" ADD COLUMN "originalFilename" TEXT;
