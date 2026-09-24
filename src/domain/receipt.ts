export type ReceiptStatus = "PENDING" | "EXTRACTING" | "EXTRACTED" | "FAILED";

export type Receipt = {
  id: string;
  claimId: string;
  objectKey: string;
  originalFilename: string;
  contentHash: string;
  mimeType: string;
  status: ReceiptStatus;
};
