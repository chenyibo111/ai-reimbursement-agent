import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const specificationPath = resolve(process.cwd(), "api/openapi/reimbursement-v1.yaml");

describe("reimbursement OpenAPI contract", () => {
  it("defines idempotent draft, safe receipt reads, upload-finalize, validation, submission request, and submit endpoints", () => {
    expect(existsSync(specificationPath)).toBe(true);

    const specification = readFileSync(specificationPath, "utf8");
    expect(specification).toContain("/api/v1/claims:");
    expect(specification).toContain("/api/v1/claims/{claimId}/uploads:");
    expect(specification).toContain("/api/v1/claims/{claimId}/receipts:");
		expect(specification).toContain("operationId: listClaimReceipts");
    expect(specification).toContain("/api/v1/claims/{claimId}/validation:");
    expect(specification).toContain("/api/v1/claims/{claimId}/submission-requests:");
    expect(specification).toContain("/api/v1/claims/{claimId}/submit:");
    expect(specification).toContain("Idempotency-Key:");
    expect(specification).toContain("ErrorResponse:");
		expect(specification).toContain("filename:");
		expect(specification).not.toContain("originalFilename:");
		expect(specification).toContain("claimNumber:");
		expect(specification).toContain("receiptCount:");
		expect(specification).toContain("recognizedReceiptCount:");
		expect(specification).toContain("totalAmountCent:");
		expect(specification).toContain("missingAmountReceiptCount:");
		expect(specification).toContain("invoiceDate:");
		expect(specification).toContain("sellerName:");
    expect(specification).toContain("code:");
  });
});
