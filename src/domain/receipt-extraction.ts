export type ExtractedField = {
  value: string | number | null;
  confidence: number;
  source: "EXTRACTED";
};

export type ReceiptExtraction = {
  receiptType: string;
  invoiceNumber: ExtractedField;
  issuedOn: ExtractedField;
  totalAmountCents: ExtractedField;
  taxAmountCents: ExtractedField;
  sellerName: ExtractedField;
};

export type ExtractionValidationIssue = {
  code: "DUPLICATE_FILE" | "DUPLICATE_INVOICE";
  severity: "BLOCKING";
};
