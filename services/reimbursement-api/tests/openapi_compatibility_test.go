package tests

import (
	"os"
	"strings"
	"testing"
)

func TestClaimEndpointsMatchOpenAPIContract(t *testing.T) {
	content, err := os.ReadFile("../../../api/openapi/reimbursement-v1.yaml")
	if err != nil { t.Fatalf("read OpenAPI specification: %v", err) }
	for _, path := range []string{"/api/v1/claims:", "/api/v1/claims/{claimId}/validation:", "/api/v1/claims/{claimId}/submission-requests:", "/api/v1/claims/{claimId}/submit:"} {
		if !strings.Contains(string(content), path) { t.Fatalf("OpenAPI missing route %s", path) }
	}
	for _, field := range []string{"claimNumber:", "receiptCount:", "recognizedReceiptCount:", "totalAmountCent:", "missingAmountReceiptCount:", "requestedAmountCent:", "currency:", "requestedAmountSource:", "remark:", "invoiceDate:", "sellerName:"} {
		if !strings.Contains(string(content), field) { t.Fatalf("OpenAPI missing receipt-display field %s", field) }
	}
}
